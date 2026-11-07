import { useCallback, useEffect, useRef, useState } from "react";
import type { BoundaryCollection, Dataset, Position, TerrainMetadata } from "../types";
import { fetchBoundaryGeoJson, fetchBoundaryShapefile } from "./boundaryShapefile";

export function useTerrainData() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [countiesLoading, setCountiesLoading] = useState(false);
  const [countiesError, setCountiesError] = useState<string | null>(null);
  const countiesRef = useRef<BoundaryCollection | null>(null);
  const countyLoadRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  const loadCounties = useCallback(() => {
    if (countiesRef.current) return Promise.resolve();
    if (countyLoadRef.current) return countyLoadRef.current;

    setCountiesLoading(true);
    setCountiesError(null);
    const request = (async () => {
      try {
        const counties = await fetchBoundaryShapefile(
          "/data/boundaries/counties.zip",
          "County",
        );
        countiesRef.current = counties;
        if (mountedRef.current) {
          setDataset((current) => current ? { ...current, counties } : current);
        }
      } catch (error) {
        if (mountedRef.current) {
          setCountiesError(
            error instanceof Error ? error.message : "Could not load county boundaries.",
          );
        }
      } finally {
        countyLoadRef.current = null;
        if (mountedRef.current) setCountiesLoading(false);
      }
    })();
    countyLoadRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;

    async function loadDataset() {
      try {
        const [metadataResponse, state, longitudeLatitudeGrid] = await Promise.all([
          fetch("/data/terrain/metadata.json"),
          fetchBoundaryShapefile("/data/boundaries/california.zip", "California"),
          fetchBoundaryGeoJson(
            "/data/boundaries/longitude_latitude_cells.geojson",
            "Longitude and latitude grid",
          ),
        ]);
        if (!metadataResponse.ok) {
          throw new Error("Terrain data has not been generated yet.");
        }
        const metadata = await metadataResponse.json() as TerrainMetadata;

        if (!active) return;
        if (
          !metadata.bounds ||
          !Array.isArray(metadata.center) ||
          !Array.isArray(metadata.tiles) ||
          !Array.isArray(metadata.zoomLevels) ||
          metadata.zoomLevels.length === 0 ||
          !metadata.zoomLevels.includes(8) ||
          !metadata.tiles.some((tile) => typeof tile === "string" && tile.startsWith("8/")) ||
          !state.features.length ||
          !longitudeLatitudeGrid.features.length ||
          longitudeLatitudeGrid.features.some((feature) =>
            typeof feature.properties.cellId !== "string" ||
            typeof feature.properties.name !== "string"
          )
        ) {
          throw new Error("Generated terrain metadata, California boundary, or longitude and latitude grid is incomplete, or zoom-8 terrain tiles are missing.");
        }

        const center: Position = [
          (metadata.bounds.minX + metadata.bounds.maxX) / 2,
          (metadata.bounds.minY + metadata.bounds.maxY) / 2,
        ];
        setDataset({
          metadata: { ...metadata, center },
          state,
          longitudeLatitudeGrid,
          counties: countiesRef.current,
        });
        setDataError(null);
      } catch (error) {
        if (!active) return;
        setDataError(
          error instanceof Error ? error.message : "Could not load generated California terrain data.",
        );
      }
    }

    void loadDataset();
    return () => {
      active = false;
      mountedRef.current = false;
    };
  }, []);

  return { dataset, dataError, countiesLoading, countiesError, loadCounties };
}
