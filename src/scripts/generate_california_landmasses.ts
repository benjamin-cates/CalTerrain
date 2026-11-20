import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCaliforniaLandmasses } from "../features/landmasses";
import type { BoundaryCollection } from "../types";

const sourcePath = new URL("../../public/data/boundaries/california.geojson", import.meta.url);
const outputPath = new URL("../../public/data/boundaries/california_landmasses.zip", import.meta.url);
const source = await Bun.file(sourcePath).json() as BoundaryCollection;
const landmasses = deriveCaliforniaLandmasses(source);
const workDirectory = await mkdtemp(join(tmpdir(), "california-landmasses-"));
try {
  const shapefileDirectory = join(workDirectory, "shapefile");
  await mkdir(shapefileDirectory);
  const geoJsonPath = join(workDirectory, "landmasses.geojson");
  const shapefilePath = join(shapefileDirectory, "california_landmasses.shp");
  const archivePath = join(workDirectory, "california_landmasses.zip");
  await Bun.write(geoJsonPath, `${JSON.stringify(landmasses)}\n`);

  const conversion = Bun.spawnSync([
    "ogr2ogr",
    "-f",
    "ESRI Shapefile",
    "-nln",
    "california_landmasses",
    shapefilePath,
    geoJsonPath,
  ]);
  if (conversion.exitCode !== 0) {
    throw new Error(
      `Could not create the landmass shapefile: ${conversion.stderr.toString().trim()}`,
    );
  }

  const shapefileParts = (await readdir(shapefileDirectory))
    .filter((name) => /\.(shp|shx|dbf|prj|cpg)$/i.test(name));
  if (!shapefileParts.some((name) => name.endsWith(".shp")) ||
    !shapefileParts.some((name) => name.endsWith(".dbf")) ||
    !shapefileParts.some((name) => name.endsWith(".shx"))) {
    throw new Error("GDAL did not create all required landmass shapefile parts.");
  }
  const archive = Bun.spawnSync(
    ["zip", "-q", "-9", "-j", archivePath, ...shapefileParts],
    { cwd: shapefileDirectory },
  );
  if (archive.exitCode !== 0) {
    throw new Error(`Could not zip the landmass shapefile: ${archive.stderr.toString().trim()}`);
  }
  await Bun.write(outputPath, await Bun.file(archivePath).arrayBuffer());
  console.log(`Wrote ${landmasses.features.length} landmasses to ${outputPath.pathname}`);
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
