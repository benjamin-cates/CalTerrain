import { useEffect, useRef, useState } from "react";
import { parseMountainTsv, type MountainPeak } from "./mountains";

const MOUNTAIN_TSV_URL = "/data/features/CA_mountains.tsv";
const EMPTY_MOUNTAINS: MountainPeak[] = [];

export function useMountainData(enabled: boolean) {
  const [peaks, setPeaks] = useState<MountainPeak[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const peaksRef = useRef<MountainPeak[] | null>(null);
  const requestRef = useRef<Promise<MountainPeak[]> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || peaksRef.current || requestRef.current) return;
    setLoading(true);
    setError(null);
    const request = (async () => {
      const response = await fetch(MOUNTAIN_TSV_URL);
      if (!response.ok) {
        throw new Error("California mountain data could not be loaded.");
      }
      return parseMountainTsv(await response.text());
    })();
    requestRef.current = request;
    void request.then((mountains) => {
      peaksRef.current = mountains;
      if (mountedRef.current) setPeaks(mountains);
    }).catch((cause: unknown) => {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : "Could not load mountain data.");
      }
    }).finally(() => {
      requestRef.current = null;
      if (mountedRef.current) setLoading(false);
    });
  }, [enabled]);

  return { peaks: peaks ?? EMPTY_MOUNTAINS, loading, error };
}
