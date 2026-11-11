import { useCallback, useEffect, useRef, useState } from "react";
import type { BoundaryCollection, TopographicFeatureOption } from "../types";
import { fetchBoundaryShapefile, getBoundaryFeatureOptions } from "../terrain/boundaryShapefile";
import {
  dissolveEcoregionFeatures,
  parseEcoregionMapMetadata,
  type EcoregionMapMetadata,
} from "./ecoregions";

const FEATURE_URL = "/data/features/CA_Eco_L4.zip";
const METADATA_URL = "/data/features/ca_ecoregion_map.json";

async function fetchMapMetadata(): Promise<EcoregionMapMetadata> {
  const response = await fetch(METADATA_URL);
  if (!response.ok) {
    throw new Error("Ecoregion map metadata could not be loaded.");
  }
  return parseEcoregionMapMetadata(await response.json());
}

export function useEcoregionData() {
  const [features, setFeatures] = useState<BoundaryCollection | null>(null);
  const [options, setOptions] = useState<TopographicFeatureOption[]>([]);
  const [mapMetadata, setMapMetadata] = useState<EcoregionMapMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const requestRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (loadedRef.current) return Promise.resolve();
    if (requestRef.current) return requestRef.current;
    setLoading(true);
    setError(null);
    const request = (async () => {
      try {
        const [sourceCollection, metadata] = await Promise.all([
          fetchBoundaryShapefile(FEATURE_URL, "Ecoregion"),
          fetchMapMetadata(),
        ]);
        const collection = dissolveEcoregionFeatures(sourceCollection);
        const level3NamesByL4Code = new Map<string, string>();
        for (const feature of collection.features) {
          const code = feature.properties.US_L4CODE;
          const name = feature.properties.US_L3NAME;
          if (
            (typeof code !== "string" && typeof code !== "number") ||
            typeof name !== "string" ||
            !String(code).trim() ||
            !name.trim()
          ) {
            throw new Error("Ecoregion data is missing a Level III region name.");
          }
          level3NamesByL4Code.set(String(code).trim(), name.trim());
        }
        const featureOptions = getBoundaryFeatureOptions(
          collection,
          "Ecoregion",
          "US_L4CODE",
          "US_L4NAME",
        ).map((option) => {
          const level3Name = level3NamesByL4Code.get(option.id);
          if (!level3Name) {
            throw new Error(`Ecoregion ${option.id} is missing its Level III region name.`);
          }
          return {
            ...option,
            moreDetail: `Level III ecoregion: ${level3Name} · Level IV ID: ${option.id}`,
          };
        });
        loadedRef.current = true;
        if (mountedRef.current) {
          setFeatures(collection);
          setOptions(featureOptions);
          setMapMetadata(metadata);
        }
      } catch (cause) {
        if (mountedRef.current) {
          setError(cause instanceof Error
            ? cause.message
            : "Ecoregion data could not be loaded.");
        }
      } finally {
        requestRef.current = null;
        if (mountedRef.current) setLoading(false);
      }
    })();
    requestRef.current = request;
    return request;
  }, []);

  return { features, options, mapMetadata, loading, error, load };
}
