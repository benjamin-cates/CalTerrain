import { useEffect, useRef, useState } from "react";
import shp from "shpjs";
import {
  parseRailwayShapefile,
  type RailwayFeatureCollection,
} from "./railways";

const RAILWAY_SHAPEFILE_URL = "/data/features/california_rail_routes.zip";

export function useRailwayData(enabled: boolean) {
  const [features, setFeatures] = useState<RailwayFeatureCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const featuresRef = useRef<RailwayFeatureCollection | null>(null);
  const requestRef = useRef<Promise<RailwayFeatureCollection> | null>(null);
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
      const response = await fetch(RAILWAY_SHAPEFILE_URL);
      if (!response.ok) {
        throw new Error("California railway shapefile could not be loaded.");
      }
      const parsed = parseRailwayShapefile(
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
        setError(cause instanceof Error ? cause.message : "Could not load railway features.");
      }
    }).finally(() => {
      requestRef.current = null;
      if (mountedRef.current) setLoading(false);
    });
  }, [enabled]);

  return { features, loading, error };
}
