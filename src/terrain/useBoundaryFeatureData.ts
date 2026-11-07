import { useCallback, useEffect, useRef, useState } from "react";
import type { BoundaryCollection, TopographicFeatureOption } from "../types";
import { fetchBoundaryShapefile, getBoundaryFeatureOptions } from "./boundaryShapefile";

export function useBoundaryFeatureData(
  url: string,
  label: string,
  idField: string,
  nameField: string,
) {
  const [features, setFeatures] = useState<BoundaryCollection | null>(null);
  const [options, setOptions] = useState<TopographicFeatureOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const featuresRef = useRef<BoundaryCollection | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (featuresRef.current) return Promise.resolve();
    if (requestRef.current) return requestRef.current;
    setLoading(true);
    setError(null);
    const request = (async () => {
      try {
        const collection = await fetchBoundaryShapefile(url, label);
        const featureOptions = getBoundaryFeatureOptions(
          collection,
          label,
          idField,
          nameField,
        );
        featuresRef.current = collection;
        if (mountedRef.current) {
          setFeatures(collection);
          setOptions(featureOptions);
        }
      } catch (cause) {
        if (mountedRef.current) {
          setError(cause instanceof Error ? cause.message : `${label} boundaries could not be loaded.`);
        }
      } finally {
        requestRef.current = null;
        if (mountedRef.current) setLoading(false);
      }
    })();
    requestRef.current = request;
    return request;
  }, [idField, label, nameField, url]);

  return { features, options, loading, error, load };
}
