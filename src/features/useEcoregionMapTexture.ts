import { useEffect, useState } from "react";
import { LinearFilter, NoColorSpace, Texture, TextureLoader } from "three";

type LoadedMap = { mode: "broad" | "fine"; texture: Texture };

const MAP_URLS = {
  broad: "/data/features/ca_ecoregions_l3.webp",
  fine: "/data/features/ca_ecoregions_l4.webp",
} as const;

export function useEcoregionMapTexture(mode: "none" | "broad" | "fine") {
  const [loadedMap, setLoadedMap] = useState<LoadedMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "none") {
      setLoadedMap(null);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    const texture = new TextureLoader().load(
      MAP_URLS[mode],
      (loadedTexture) => {
        if (!active) {
          loadedTexture.dispose();
          return;
        }
        loadedTexture.colorSpace = NoColorSpace;
        loadedTexture.minFilter = LinearFilter;
        loadedTexture.magFilter = LinearFilter;
        loadedTexture.generateMipmaps = false;
        loadedTexture.needsUpdate = true;
        setLoadedMap({ mode, texture: loadedTexture });
        setLoading(false);
      },
      undefined,
      () => {
        if (!active) return;
        setError(`The ${mode} ecoregion color map could not be loaded.`);
        setLoading(false);
      },
    );
    return () => {
      active = false;
      texture.dispose();
    };
  }, [mode]);

  return {
    texture: loadedMap?.mode === mode ? loadedMap.texture : null,
    loading,
    error,
  };
}
