import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseCustomMountainPeaks,
  type MountainPeak,
} from "./mountains";

const STORAGE_KEY = "calterrain-custom-mountain-peaks";

export type NewCustomMountainPeak = Omit<MountainPeak, "id" | "custom">;

export function useCustomMountainPeaks() {
  const [peaks, setPeaks] = useState<MountainPeak[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const peaksRef = useRef<MountainPeak[]>([]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      const loaded = saved ? parseCustomMountainPeaks(saved) : [];
      peaksRef.current = loaded;
      setPeaks(loaded);
    } catch (cause) {
      setStorageError(
        cause instanceof Error
          ? `Custom mountain peaks could not be loaded: ${cause.message}`
          : "Custom mountain peaks could not be loaded from browser storage.",
      );
    } finally {
      setStorageLoaded(true);
    }
  }, []);

  const save = useCallback((next: MountainPeak[]) => {
    peaksRef.current = next;
    setPeaks(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setStorageError(null);
    } catch (cause) {
      setStorageError(
        cause instanceof Error
          ? `Custom mountain peaks could not be saved: ${cause.message}`
          : "Custom mountain peaks could not be saved to browser storage.",
      );
    }
  }, []);

  const addPeak = useCallback((peak: NewCustomMountainPeak): MountainPeak => {
    const savedPeak: MountainPeak = {
      ...peak,
      id: crypto.randomUUID(),
      custom: true,
    };
    save([...peaksRef.current, savedPeak]);
    return savedPeak;
  }, [save]);

  const removePeak = useCallback((id: string) => {
    save(peaksRef.current.filter((peak) => peak.id !== id));
  }, [save]);

  return { peaks, storageError, storageLoaded, addPeak, removePeak };
}
