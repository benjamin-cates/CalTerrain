import { useEffect, useRef, useState } from "react";
import shp, { type ShapefileResult } from "shpjs";
import type { HighwayFeatureCollection } from "./highways";

const HIGHWAY_SHAPEFILE_URL = "/data/features/State_Highway_Network_Odometer_simple.zip";

function isHighwayFeatureCollection(parsed: ShapefileResult): parsed is HighwayFeatureCollection {
  return !Array.isArray(parsed) &&
    parsed.type === "FeatureCollection" &&
    Array.isArray(parsed.features) &&
    parsed.features.every((feature) =>
      feature.geometry === null ||
      feature.geometry.type === "LineString" ||
      feature.geometry.type === "MultiLineString"
    );
}

export function useHighwayData(enabled: boolean) {
  const [features, setFeatures] = useState<HighwayFeatureCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const featuresRef = useRef<HighwayFeatureCollection | null>(null);
  const requestRef = useRef<Promise<HighwayFeatureCollection> | null>(null);
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
      const response = await fetch(HIGHWAY_SHAPEFILE_URL);
      if (!response.ok) {
        throw new Error("California highway shapefile could not be loaded.");
      }
      const parsed = await shp(await response.arrayBuffer());
      if (!isHighwayFeatureCollection(parsed)) {
        throw new Error("California highway shapefile has invalid route geometry.");
      }
      if (parsed.features.length === 0) {
        throw new Error("California highway shapefile contains no route features.");
      }
      const collection: HighwayFeatureCollection = parsed;
      if (!collection.features.some((feature) => feature.geometry && feature.properties.RouteNum)) {
        throw new Error("California highway shapefile is missing route numbers or line geometry.");
      }
      return collection;
    })();
    requestRef.current = request;
    void request.then((collection) => {
      featuresRef.current = collection;
      if (mountedRef.current) setFeatures(collection);
    }).catch((cause: unknown) => {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : "Could not load highway features.");
      }
    }).finally(() => {
      requestRef.current = null;
      if (mountedRef.current) setLoading(false);
    });
  }, [enabled]);

  return { features, loading, error };
}
