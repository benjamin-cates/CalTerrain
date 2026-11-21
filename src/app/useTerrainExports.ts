import { useCallback, useMemo, useState } from "react";
import { createRegionBoundaryExport } from "../regions/export";
import type {
  BoundaryCollection,
  ClipFeatureSelections,
  Dataset,
  Region,
  ViewSettings,
} from "../types";
import type { TerrainHeightPalette } from "../terrain/terrainHeightPalette";
import {
  createTerrainExportRegions,
  createTerrainImageCanvas,
  createTerrainModelGlb,
  createTerrainModelStl,
  getTerrainGroundScale,
  terrainExportFilename,
  type TerrainModelFileFormat,
  type TerrainExportProgress,
  type TerrainExportOptions,
  type TerrainExportRegion,
  type TerrainExportTriangleReport,
} from "../terrain/terrainExport";
import type { TerrainModelOptions } from "../terrain/terrainOrnament";
import { createTerrainOutlineSvg } from "../terrain/terrainOutline";
import { fromLocal } from "../geo";

type UseTerrainExportsOptions = {
  dataset: Dataset | null;
  regions: Region[];
  clipSelections: ClipFeatureSelections;
  nationalParkFeatures: BoundaryCollection | null;
  nationalForestFeatures: BoundaryCollection | null;
  ecoregionFeatures: BoundaryCollection | null;
  settings: ViewSettings;
  heightPalette: TerrainHeightPalette;
};

function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode the terrain canvas as a PNG."));
    }, "image/png");
  });
}

export function useTerrainExports({
  dataset,
  regions,
  clipSelections,
  nationalParkFeatures,
  nationalForestFeatures,
  ecoregionFeatures,
  settings,
  heightPalette,
}: UseTerrainExportsOptions) {
  const [terrainExportBusy, setTerrainExportBusy] = useState(false);
  const [terrainExportStatus, setTerrainExportStatus] = useState<string | null>(null);
  const [terrainExportError, setTerrainExportError] = useState<string | null>(null);
  const [terrainExportTriangleReport, setTerrainExportTriangleReport] =
    useState<TerrainExportTriangleReport | null>(null);
  const longitudeLatitudeGrid = dataset?.longitudeLatitudeGrid ?? null;

  const preparedTerrainExportData = useMemo(() => {
    if (!dataset) return { regions: [], californiaPolygons: [] };
    const boundaryCollection = createRegionBoundaryExport(
      regions,
      clipSelections,
      dataset.metadata.center,
      dataset.counties,
      nationalParkFeatures,
      nationalForestFeatures,
      longitudeLatitudeGrid,
      ecoregionFeatures,
      dataset.state,
    );
    return createTerrainExportRegions(
      boundaryCollection,
      dataset.state,
      dataset.metadata.center,
    );
  }, [
    clipSelections,
    dataset,
    ecoregionFeatures,
    longitudeLatitudeGrid,
    nationalForestFeatures,
    nationalParkFeatures,
    regions,
  ]);
  const preparedTerrainExportRegions = preparedTerrainExportData.regions;
  const exportTerrainModel = useCallback(async (
    format: TerrainModelFileFormat,
    regionId: string,
    resolutionMeters: number,
    model: TerrainModelOptions,
  ) => {
    if (!dataset || terrainExportBusy) return;
    setTerrainExportBusy(true);
    setTerrainExportError(null);
    setTerrainExportTriangleReport(null);
    setTerrainExportStatus(`Preparing ${format.toUpperCase()} model…`);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    try {
      const region = preparedTerrainExportRegions.find((item) => item.id === regionId);
      if (!region) throw new Error("The requested model region is no longer selected.");
      const options: Omit<TerrainExportOptions, "californiaLatitudeSpanMeters"> = {
        metadata: dataset.metadata,
        center: dataset.metadata.center,
        californiaPolygons: preparedTerrainExportData.californiaPolygons,
        region,
        resolutionMeters,
        verticalExaggeration: settings.exaggeration,
        onProgress: ({ tileIndex, tileCount, regionName }) => {
          setTerrainExportStatus(
            `Exporting ${regionName} · tile ${tileIndex.toLocaleString("en-US")} of ${tileCount.toLocaleString("en-US")}`,
          );
        },
        onTriangleCount: (count) =>
          setTerrainExportTriangleReport({
            pieces: [{ id: region.id, name: region.name, count }],
            total: count,
          }),
      };
      const modelData = format === "glb"
        ? await createTerrainModelGlb(options, model)
        : await createTerrainModelStl(options, model);
      downloadFile(
        new Blob([modelData], {
          type: format === "glb" ? "model/gltf-binary" : "model/stl",
        }),
        terrainExportFilename(region.name).replace(/\.glb$/, `.${format}`),
      );
    } catch (error) {
      setTerrainExportError(
        error instanceof Error
          ? error.message
          : `Could not export the ${format.toUpperCase()} model.`,
      );
    } finally {
      setTerrainExportBusy(false);
      setTerrainExportStatus(null);
    }
  }, [
    dataset,
    preparedTerrainExportData.californiaPolygons,
    preparedTerrainExportRegions,
    settings.exaggeration,
    terrainExportBusy,
  ]);

  const exportOutline = useCallback((regionId: string) => {
    if (!dataset) return;
    const region = preparedTerrainExportRegions.find((item) => item.id === regionId);
    if (!region) {
      setTerrainExportError("The requested outline region is no longer selected.");
      return;
    }
    setTerrainExportError(null);
    const polygons = region.polygons.map((polygon) =>
      polygon.map((ring) =>
        ring.map((point) => fromLocal(point, dataset.metadata.center))
      )
    );
    const geometry = polygons.length === 1
      ? { type: "Polygon" as const, coordinates: polygons[0]! }
      : { type: "MultiPolygon" as const, coordinates: polygons };
    downloadFile(
      new Blob([JSON.stringify({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: { id: region.id, name: region.name },
          geometry,
        }],
      }, null, 2)], { type: "application/geo+json" }),
      terrainExportFilename(region.name).replace(/\.glb$/, ".geojson"),
    );
  }, [dataset, preparedTerrainExportRegions]);

  const exportOutlineSvg = useCallback((regionId: string) => {
    const region = preparedTerrainExportRegions.find((item) => item.id === regionId);
    if (!region) {
      setTerrainExportError("The requested outline region is no longer selected.");
      return;
    }
    setTerrainExportError(null);
    try {
      downloadFile(
        new Blob([createTerrainOutlineSvg(region)], { type: "image/svg+xml" }),
        terrainExportFilename(region.name).replace(/\.glb$/, ".svg"),
      );
    } catch (error) {
      setTerrainExportError(
        error instanceof Error ? error.message : "Could not export the SVG outline.",
      );
    }
  }, [preparedTerrainExportRegions]);

  const exportImage = useCallback(async (
    regionId: string,
    resolutionMeters: number,
  ) => {
    if (!dataset || terrainExportBusy) return;
    setTerrainExportBusy(true);
    setTerrainExportError(null);
    setTerrainExportTriangleReport(null);
    setTerrainExportStatus("Preparing terrain image…");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    try {
      const region = preparedTerrainExportRegions.find((item) => item.id === regionId);
      if (!region) throw new Error("The requested image region is no longer selected.");
      const reportProgress = ({ tileIndex, tileCount, regionName }: TerrainExportProgress) => {
        setTerrainExportStatus(
          `Rendering ${regionName} · tile ${tileIndex.toLocaleString("en-US")} of ${tileCount.toLocaleString("en-US")}`,
        );
      };
      const optionsForRegion = (region: TerrainExportRegion) => ({
        metadata: dataset.metadata,
        center: dataset.metadata.center,
        region,
        resolutionMeters,
        palette: heightPalette,
        onProgress: reportProgress,
      });
      const canvas = await createTerrainImageCanvas(optionsForRegion(region));
      const blob = await canvasToPng(canvas);
      downloadFile(blob, terrainExportFilename(region.name).replace(/\.glb$/, ".png"));
    } catch (error) {
      setTerrainExportError(
        error instanceof Error ? error.message : "Could not export the selected terrain image.",
      );
    } finally {
      setTerrainExportBusy(false);
      setTerrainExportStatus(null);
    }
  }, [
    dataset,
    heightPalette,
    preparedTerrainExportRegions,
    terrainExportBusy,
  ]);

  return {
    exportImage,
    exportTerrainModel,
    exportOutline,
    exportOutlineSvg,
    preparedTerrainExportRegions,
    terrainExportBusy,
    terrainExportError,
    terrainExportGroundScale: dataset ? getTerrainGroundScale(dataset.metadata.center) : 1,
    terrainExportStatus,
    terrainExportTriangleReport,
  };
}
