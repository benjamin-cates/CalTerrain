import { useEffect, useRef, useState } from "react";
import shp from "shpjs";
import { parseRiverShapefile, type RiverFeatureCollection } from "./rivers";

const RIVER_SHAPEFILE_URL = "/data/features/nhd_major_rivers.zip";

export function useRiverData(enabled: boolean) {
  const [features, setFeatures] = useState<RiverFeatureCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const featuresRef = useRef<RiverFeatureCollection | null>(null);
  const requestRef = useRef<Promise<RiverFeatureCollection> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || featuresRef.current || requestRef.current) return;
    setLoading(true);
    setError(null);
    const request = (async () => {
      const response = await fetch(RIVER_SHAPEFILE_URL);
      if (!response.ok) {
        throw new Error("National Hydrography Dataset river shapefile could not be loaded.");
      }
      const parsed = parseRiverShapefile(
        await shp(await response.arrayBuffer()),
      );
      return parsed;
    })();
    requestRef.current = request;
    void request.then((collection) => {
      featuresRef.current = collection;
      if (mountedRef.current) setFeatures(collection);
    }).catch((cause: unknown) => {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : "Could not load river features.");
      }
    }).finally(() => {
      requestRef.current = null;
      if (mountedRef.current) setLoading(false);
    });
  }, [enabled]);

  return { features, loading, error };
}
