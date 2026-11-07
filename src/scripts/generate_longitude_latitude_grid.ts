import { readFile, writeFile } from "node:fs/promises";
import { createLongitudeLatitudeGrid } from "../longitudeLatitudeGrid";
import type { BoundaryCollection } from "../types";

const californiaBoundaryPath = new URL(
  "../../public/data/boundaries/california.geojson",
  import.meta.url,
);
const gridPath = new URL(
  "../../public/data/boundaries/longitude_latitude_cells.geojson",
  import.meta.url,
);

const californiaBoundary = JSON.parse(
  await readFile(californiaBoundaryPath, "utf8"),
) as BoundaryCollection;
if (
  californiaBoundary.type !== "FeatureCollection" ||
  !Array.isArray(californiaBoundary.features) ||
  californiaBoundary.features.length === 0
) {
  throw new Error("The California boundary GeoJSON is empty or invalid.");
}

const grid = createLongitudeLatitudeGrid(californiaBoundary);
if (grid.features.length === 0) {
  throw new Error("No longitude and latitude cells intersect the California boundary.");
}

await writeFile(gridPath, `${JSON.stringify(grid)}\n`, "utf8");
console.log(`Wrote ${grid.features.length} cells to ${gridPath.pathname}`);
