import { useCallback, useMemo, useState } from "react";
import {
  clipFeatureExportRegionId,
  createRegionBoundaryExport,
} from "../regions/export";
import type {
  BoundaryCollection,
  ClipFeatureCategory,
  ClipFeatureSelections,
  Dataset,
  Region,
  TopographicFeatureCategory,
  TopographicFeatureOption,
  ViewSettings,
} from "../types";
import type { TerrainHeightPalette } from "../terrain/terrainHeightPalette";
import {
  combineTerrainExportRegions,
  createStoreZip,
  createTerrainExportRegions,
  createTerrainGlb,
  createTerrainImageCanvas,
  getTerrainGroundScale,
  terrainExportFilename,
  type TerrainExportProgress,
  type TerrainExportRegion,
  type TerrainExportTriangleReport,
} from "../terrain/terrainExport";

type ExportMode = "region" | "zip" | "combined";

type UseTerrainExportsOptions = {
  dataset: Dataset | null;
  regions: Region[];
  clipSelections: ClipFeatureSelections;
  topographicOptions: Record<TopographicFeatureCategory, TopographicFeatureOption[]>;
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
  topographicOptions,
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

  const clipExportRegions = useMemo(() => {
    const items = regions
      .filter((region) =>
        region.type !== "county" &&
        region.type !== "point" &&
        region.type !== "polyline" &&
        region.clip === true
      )
      .map((region) => ({ id: region.id, name: region.name }));
    const categories: { id: ClipFeatureCategory; prefix: string }[] = [
      { id: "counties", prefix: "County" },
      { id: "nationalParks", prefix: "National park" },
      { id: "nationalForests", prefix: "National forest" },
      { id: "longitudeLatitudeLines", prefix: "Grid cell" },
      { id: "ecoregions", prefix: "Ecoregion" },
    ];
    for (const { id, prefix } of categories) {
      for (const selectedId of clipSelections[id]) {
        const option = topographicOptions[id].find((item) => item.id === selectedId);
        if (option) {
          items.push({
            id: clipFeatureExportRegionId(id, selectedId),
            name: `${prefix}: ${option.label}`,
          });
        }
      }
    }
    return items;
  }, [clipSelections, regions, topographicOptions]);

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
  const combinedImageRegion = useMemo(
    () => preparedTerrainExportRegions.length > 1
      ? combineTerrainExportRegions(
        preparedTerrainExportRegions,
        preparedTerrainExportData.californiaPolygons,
      )
      : null,
    [preparedTerrainExportData.californiaPolygons, preparedTerrainExportRegions],
  );

  const exportClipRegions = useCallback(() => {
    if (!dataset) return;
    const collection = createRegionBoundaryExport(
      regions,
      clipSelections,
      dataset.metadata.center,
      dataset.counties,
      nationalParkFeatures,
      nationalForestFeatures,
      longitudeLatitudeGrid,
      ecoregionFeatures,
    );
    const blob = new Blob([JSON.stringify(collection, null, 2)], {
      type: "application/geo+json",
    });
    downloadFile(blob, "california-region-boundaries.geojson");
  }, [
    clipSelections,
    dataset,
    ecoregionFeatures,
    longitudeLatitudeGrid,
    nationalForestFeatures,
    nationalParkFeatures,
    regions,
  ]);

  const exportTerrain = useCallback(async (
    mode: ExportMode,
    regionId: string | null,
    resolutionMeters: number,
    californiaLatitudeSpanMeters: number,
  ) => {
    if (!dataset || terrainExportBusy) return;
    setTerrainExportBusy(true);
    setTerrainExportError(null);
    setTerrainExportTriangleReport(null);
    setTerrainExportStatus("Preparing clipped terrain…");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    try {
      const boundaryCollection = createRegionBoundaryExport(
        regions,
        clipSelections,
        dataset.metadata.center,
        dataset.counties,
        nationalParkFeatures,
        nationalForestFeatures,
        longitudeLatitudeGrid,
        ecoregionFeatures,
      );
      const { regions: exportRegions, californiaPolygons } = createTerrainExportRegions(
        boundaryCollection,
        dataset.state,
        dataset.metadata.center,
      );
      if (exportRegions.length === 0) {
        throw new Error("No selected regions intersect California.");
      }
      const reportProgress = ({ tileIndex, tileCount, regionName }: TerrainExportProgress) => {
        setTerrainExportStatus(
          `Exporting ${regionName} · tile ${tileIndex.toLocaleString("en-US")} of ${tileCount.toLocaleString("en-US")}`,
        );
      };
      const triangleCounts: TerrainExportTriangleReport["pieces"] = [];
      const createGlb = (region: (typeof exportRegions)[number]) => createTerrainGlb({
        metadata: dataset.metadata,
        center: dataset.metadata.center,
        californiaPolygons,
        region,
        resolutionMeters,
        californiaLatitudeSpanMeters,
        verticalExaggeration: settings.exaggeration,
        onProgress: reportProgress,
        onTriangleCount: (count) =>
          triangleCounts.push({ id: region.id, name: region.name, count }),
      });

      if (mode === "region") {
        const region = regionId === null
          ? undefined
          : exportRegions.find((item) => item.id === regionId);
        if (!region) throw new Error("The requested export region is no longer selected.");
        setTerrainExportStatus(`Exporting ${region.name}…`);
        const glb = await createGlb(region);
        downloadFile(
          new Blob([glb], { type: "model/gltf-binary" }),
          terrainExportFilename(region.name),
        );
      } else if (mode === "combined") {
        const combined = combineTerrainExportRegions(exportRegions, californiaPolygons);
        const glb = await createGlb(combined);
        downloadFile(
          new Blob([glb], { type: "model/gltf-binary" }),
          "california-combined-regions.glb",
        );
      } else {
        const entries: { name: string; content: Uint8Array<ArrayBuffer> }[] = [];
        const usedNames = new Set<string>();
        for (let index = 0; index < exportRegions.length; index += 1) {
          const region = exportRegions[index];
          if (!region) continue;
          const glb = new Uint8Array(await createGlb(region));
          const filename = terrainExportFilename(region.name);
          let uniqueFilename = filename;
          let suffix = 2;
          while (usedNames.has(uniqueFilename)) {
            uniqueFilename = filename.replace(/\.glb$/, `-${suffix}.glb`);
            suffix += 1;
          }
          usedNames.add(uniqueFilename);
          entries.push({ name: uniqueFilename, content: glb });
        }
        setTerrainExportStatus("Packaging GLB files…");
        const archive = createStoreZip(entries);
        downloadFile(archive, "california-region-exports.zip");
      }
      setTerrainExportTriangleReport({
        pieces: triangleCounts,
        total: triangleCounts.reduce((total, piece) => total + piece.count, 0),
      });
    } catch (error) {
      setTerrainExportError(
        error instanceof Error ? error.message : "Could not export the selected terrain.",
      );
    } finally {
      setTerrainExportBusy(false);
      setTerrainExportStatus(null);
    }
  }, [
    clipSelections,
    dataset,
    ecoregionFeatures,
    longitudeLatitudeGrid,
    nationalForestFeatures,
    nationalParkFeatures,
    regions,
    settings.exaggeration,
    terrainExportBusy,
  ]);

  const exportImage = useCallback(async (
    mode: ExportMode,
    regionId: string | null,
    resolutionMeters: number,
  ) => {
    if (!dataset || terrainExportBusy) return;
    setTerrainExportBusy(true);
    setTerrainExportError(null);
    setTerrainExportTriangleReport(null);
    setTerrainExportStatus("Preparing terrain image…");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    try {
      if (preparedTerrainExportRegions.length === 0) {
        throw new Error("No selected regions intersect California.");
      }
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
      if (mode === "combined") {
        if (!combinedImageRegion) {
          throw new Error("At least two cut regions are required for a combined image.");
        }
        const canvas = await createTerrainImageCanvas(optionsForRegion(combinedImageRegion));
        const blob = await canvasToPng(canvas);
        downloadFile(blob, "california-combined-regions.png");
      } else if (mode === "region") {
        const region = regionId === null
          ? undefined
          : preparedTerrainExportRegions.find((item) => item.id === regionId);
        if (!region) throw new Error("The requested export region is no longer selected.");
        const canvas = await createTerrainImageCanvas(optionsForRegion(region));
        const blob = await canvasToPng(canvas);
        downloadFile(blob, terrainExportFilename(region.name).replace(/\.glb$/, ".png"));
      } else {
        const entries: { name: string; content: Uint8Array<ArrayBuffer> }[] = [];
        const usedNames = new Set<string>();
        for (const region of preparedTerrainExportRegions) {
          const canvas = await createTerrainImageCanvas(optionsForRegion(region));
          const blob = await canvasToPng(canvas);
          const filename = terrainExportFilename(region.name).replace(/\.glb$/, ".png");
          let uniqueFilename = filename;
          let suffix = 2;
          while (usedNames.has(uniqueFilename)) {
            uniqueFilename = filename.replace(/\.png$/, `-${suffix}.png`);
            suffix += 1;
          }
          usedNames.add(uniqueFilename);
          entries.push({
            name: uniqueFilename,
            content: new Uint8Array(await blob.arrayBuffer()),
          });
        }
        setTerrainExportStatus("Packaging PNG files…");
        downloadFile(createStoreZip(entries), "california-region-images.zip");
      }
    } catch (error) {
      setTerrainExportError(
        error instanceof Error ? error.message : "Could not export the selected terrain image.",
      );
    } finally {
      setTerrainExportBusy(false);
      setTerrainExportStatus(null);
    }
  }, [
    combinedImageRegion,
    dataset,
    heightPalette,
    preparedTerrainExportRegions,
    terrainExportBusy,
  ]);

  return {
    clipExportRegions,
    combinedImageRegion,
    exportClipRegions,
    exportImage,
    exportTerrain,
    preparedTerrainExportRegions,
    terrainExportBusy,
    terrainExportError,
    terrainExportGroundScale: dataset ? getTerrainGroundScale(dataset.metadata.center) : 1,
    terrainExportStatus,
    terrainExportTriangleReport,
  };
}
