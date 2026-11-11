import type { TerrainHeightPalette } from "../terrain/terrainHeightPalette";

export const HEIGHT_PALETTES: { id: TerrainHeightPalette; label: string; gradient: string }[] = [
  {
    id: "grayscale",
    label: "Greyscale",
    gradient: "linear-gradient(90deg, #000000, #ffffff)",
  },
  {
    id: "rainbow",
    label: "Rainbow",
    gradient: "linear-gradient(90deg in srgb-linear, #152273 0%, #11406f 16.7%, #165978 33.3%, #237828 50%, #7b8416 66.7%, #e27552 83.3%, #f98c88 100%)",
  },
  {
    id: "viridis",
    label: "Viridis",
    gradient: "linear-gradient(90deg, #440154 0%, #3b528b 25%, #21918c 50%, #5ec962 75%, #fde725 100%)",
  },
  {
    id: "magma",
    label: "Magma",
    gradient: "linear-gradient(90deg, #000004 0%, #51127c 25%, #b73779 50%, #fc8961 75%, #fcfdbf 100%)",
  },
];
