import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BoundaryCollection,
  BoundaryFeature,
  Bounds,
} from "../types";
import { geographicToMercator } from "../geo";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_PATH = join(ROOT, "public/data/features/CA_Eco_L4.zip");
const COLOR_MAP_PATH = join(ROOT, "public/data/features/ca_ecoregion_colors.json");
const STATE_BOUNDARY_PATH = join(ROOT, "public/data/boundaries/california.geojson");
const OUTPUT_DIRECTORY = join(ROOT, "public/data/features");
const OUTPUT_PATHS = {
  broadMap: join(OUTPUT_DIRECTORY, "ca_ecoregions_l3.webp"),
  fineMap: join(OUTPUT_DIRECTORY, "ca_ecoregions_l4.webp"),
  metadata: join(OUTPUT_DIRECTORY, "ca_ecoregion_map.json"),
};
const RESOLUTION_METERS = 120;
const PADDING_PIXELS = 5;

type EcoregionLevel = {
  key: "l3" | "l4";
  codeField: "US_L3CODE" | "US_L4CODE";
  nameField: "US_L3NAME" | "US_L4NAME";
};

type RgbStyle = {
  red: number;
  green: number;
  blue: number;
};

type EcoregionMapMetadata = {
  projection: "EPSG:3857";
  resolutionMeters: number;
  paddingPixels: number;
  width: number;
  height: number;
  bounds: Bounds;
};

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stdout.trim()) process.stdout.write(stdout);
        if (stderr.trim()) process.stderr.write(stderr);
        if (error) {
          reject(new Error(`${command} failed: ${error.message}`));
          return;
        }
        resolve();
      },
    );
  });
}

function isBoundaryCollection(value: unknown): value is BoundaryCollection {
  if (typeof value !== "object" || value === null) return false;
  const collection = value as { type?: unknown; features?: unknown };
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    return false;
  }
  return collection.features.every((feature: unknown) => {
    if (typeof feature !== "object" || feature === null) return false;
    const item = feature as {
      type?: unknown;
      properties?: unknown;
      geometry?: { type?: unknown } | null;
    };
    return item.type === "Feature" &&
      typeof item.properties === "object" &&
      item.properties !== null &&
      item.geometry !== null &&
      (item.geometry?.type === "Polygon" || item.geometry?.type === "MultiPolygon");
  });
}

async function readCollection(path: string, label: string): Promise<BoundaryCollection> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isBoundaryCollection(parsed) || parsed.features.length === 0) {
    throw new Error(`${label} did not produce a valid polygon FeatureCollection.`);
  }
  return parsed;
}

async function readEcoregionColors(path: string): Promise<Map<string, RgbStyle>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The ecoregion color map must be an identifier-to-hex-color object.");
  }
  const colors = new Map<string, RgbStyle>();
  for (const [code, value] of Object.entries(parsed)) {
    if (!code.trim() || typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
      throw new Error(`The ecoregion color map has an invalid entry for ${code || "(empty ID)"}.`);
    }
    colors.set(code, {
      red: Number.parseInt(value.slice(1, 3), 16),
      green: Number.parseInt(value.slice(3, 5), 16),
      blue: Number.parseInt(value.slice(5, 7), 16),
    });
  }
  if (colors.size === 0) {
    throw new Error("The ecoregion color map contains no colors.");
  }
  return colors;
}

function colorCollection(
  collection: BoundaryCollection,
  level: EcoregionLevel,
  styles: Map<string, RgbStyle>,
): BoundaryCollection {
  const usedIds = new Set<string>();
  const features: BoundaryFeature[] = collection.features
    .map((feature, index) => {
      const codeValue = feature.properties[level.codeField];
      const nameValue = feature.properties[level.nameField];
      const nameCount = Number(feature.properties.REGION_NAME_COUNT);
      if (
        (typeof codeValue !== "string" && typeof codeValue !== "number") ||
        typeof nameValue !== "string" ||
        !String(codeValue).trim() ||
        !nameValue.trim()
      ) {
        throw new Error(`${level.key.toUpperCase()} feature ${index + 1} is missing its code or name.`);
      }
      if (nameCount !== 1) {
        throw new Error(`${level.key.toUpperCase()} region ${codeValue} has inconsistent names.`);
      }
      const level3Name = feature.properties.US_L3NAME;
      if (
        level.key === "l4" &&
        (typeof level3Name !== "string" ||
          !level3Name.trim() ||
          Number(feature.properties.REGION_L3_NAME_COUNT) !== 1)
      ) {
        throw new Error(`L4 region ${codeValue} has inconsistent Level 3 region names.`);
      }
      const code = String(codeValue).trim();
      if (usedIds.has(code)) {
        throw new Error(`${level.key.toUpperCase()} dissolve produced duplicate region ID ${code}.`);
      }
      usedIds.add(code);
      const style = styles.get(code);
      if (!style) {
        throw new Error(`The ecoregion color map is missing ${level.key.toUpperCase()} region ${code}.`);
      }
      const color = `#${[style.red, style.green, style.blue].map((channel) =>
        channel.toString(16).padStart(2, "0")
      ).join("")}`;
      const properties = { ...feature.properties };
      delete properties.REGION_NAME_COUNT;
      delete properties.REGION_L3_NAME_COUNT;
      properties[level.codeField] = code;
      properties[level.nameField] = nameValue.trim();
      if (level.key === "l4" && typeof level3Name === "string") {
        properties.US_L3NAME = level3Name.trim();
      }
      properties.color = color;
      properties.red = style.red;
      properties.green = style.green;
      properties.blue = style.blue;
      return { ...feature, properties };
    })
    .sort((left, right) =>
      String(left.properties[level.codeField]).localeCompare(
        String(right.properties[level.codeField]),
        undefined,
        { numeric: true },
      )
    );
  return { type: "FeatureCollection", features };
}

function dissolveSql(level: EcoregionLevel): string {
  const level3Fields = level.key === "l4"
    ? `
      MIN(US_L3NAME) AS US_L3NAME,
      COUNT(DISTINCT US_L3NAME) AS REGION_L3_NAME_COUNT,`
    : "";
  return `
    SELECT
      ${level.codeField} AS ${level.codeField},
      MIN(${level.nameField}) AS ${level.nameField},
      COUNT(DISTINCT ${level.nameField}) AS REGION_NAME_COUNT,
      ${level3Fields}
      ST_Multi(
        ST_CollectionExtract(
          ST_Union(ST_MakeValid(geometry)),
          3
        )
      ) AS geometry
    FROM ca_eco_l4
    WHERE ${level.codeField} IS NOT NULL
      AND TRIM(${level.codeField}) <> ''
      AND ${level.nameField} IS NOT NULL
      AND TRIM(${level.nameField}) <> ''
    GROUP BY ${level.codeField}
  `;
}

function getProjectedBounds(collection: BoundaryCollection): Bounds {
  const bounds: Bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  for (const feature of collection.features) {
    const polygons = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (const [longitude, latitude] of ring) {
          const [x, y] = geographicToMercator(longitude, latitude);
          bounds.minX = Math.min(bounds.minX, x);
          bounds.minY = Math.min(bounds.minY, y);
          bounds.maxX = Math.max(bounds.maxX, x);
          bounds.maxY = Math.max(bounds.maxY, y);
        }
      }
    }
  }
  if (Object.values(bounds).some((value) => !Number.isFinite(value))) {
    throw new Error("The California boundary has no valid projected coordinates.");
  }
  return bounds;
}

function createMapMetadata(stateBounds: Bounds): EcoregionMapMetadata {
  const padding = RESOLUTION_METERS * PADDING_PIXELS;
  const width = Math.ceil((stateBounds.maxX - stateBounds.minX) / RESOLUTION_METERS) +
    PADDING_PIXELS * 2;
  const height = Math.ceil((stateBounds.maxY - stateBounds.minY) / RESOLUTION_METERS) +
    PADDING_PIXELS * 2;
  const minX = stateBounds.minX - padding;
  const maxY = stateBounds.maxY + padding;
  return {
    projection: "EPSG:3857",
    resolutionMeters: RESOLUTION_METERS,
    paddingPixels: PADDING_PIXELS,
    width,
    height,
    bounds: {
      minX,
      minY: maxY - height * RESOLUTION_METERS,
      maxX: minX + width * RESOLUTION_METERS,
      maxY,
    },
  };
}

async function writeRegionMap(
  inputGeoJsonPath: string,
  stateGeoJsonPath: string,
  rasterPath: string,
  webpPath: string,
  metadata: EcoregionMapMetadata,
): Promise<void> {
  const { bounds, width, height } = metadata;
  await run("gdal_create", [
    "-of",
    "GTiff",
    "-outsize",
    String(width),
    String(height),
    "-bands",
    "4",
    "-ot",
    "Byte",
    "-a_srs",
    metadata.projection,
    "-a_ullr",
    String(bounds.minX),
    String(bounds.maxY),
    String(bounds.maxX),
    String(bounds.minY),
    "-co",
    "PHOTOMETRIC=RGB",
    "-co",
    "ALPHA=YES",
    "-burn",
    "0",
    rasterPath,
  ]);
  for (const [band, field] of [[1, "red"], [2, "green"], [3, "blue"]] as const) {
    await run("gdal_rasterize", [
      "-q",
      "-b",
      String(band),
      "-a",
      field,
      inputGeoJsonPath,
      rasterPath,
    ]);
  }
  await run("gdal_rasterize", [
    "-q",
    "-b",
    "4",
    "-burn",
    "255",
    stateGeoJsonPath,
    rasterPath,
  ]);
  await run("gdal_translate", [
    "-of",
    "WEBP",
    "-colorinterp",
    "red,green,blue,alpha",
    "-co",
    "LOSSLESS=YES",
    "-co",
    "EXACT=1",
    "-co",
    "METHOD=6",
    rasterPath,
    webpPath,
  ]);
}

async function generateEcoregionMaps(): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "calterrain-ecoregions-"));
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  try {
    const levels: EcoregionLevel[] = [
      {
        key: "l3",
        codeField: "US_L3CODE",
        nameField: "US_L3NAME",
      },
      {
        key: "l4",
        codeField: "US_L4CODE",
        nameField: "US_L4NAME",
      },
    ];
    const colors = await readEcoregionColors(COLOR_MAP_PATH);
    const temporaryCollections = new Map<EcoregionLevel["key"], string>();
    for (const level of levels) {
      const dissolvedPath = join(temporaryDirectory, `${level.key}_dissolved.geojson`);
      await run("ogr2ogr", [
        "-f",
        "GeoJSON",
        dissolvedPath,
        `/vsizip/${SOURCE_PATH}`,
        "-dialect",
        "SQLite",
        "-sql",
        dissolveSql(level),
        "-t_srs",
        "EPSG:4326",
        "-lco",
        "RFC7946=YES",
      ]);
      const dissolved = await readCollection(dissolvedPath, level.key.toUpperCase());
      const colored = colorCollection(dissolved, level, colors);
      const coloredPath = join(temporaryDirectory, `${level.key}_colored.geojson`);
      await writeFile(coloredPath, `${JSON.stringify(colored)}\n`, "utf8");
      temporaryCollections.set(level.key, coloredPath);
    }

    const stateBoundary = await readCollection(STATE_BOUNDARY_PATH, "California boundary");
    const metadata = createMapMetadata(getProjectedBounds(stateBoundary));
    const stateProjectedPath = join(temporaryDirectory, "california_3857.geojson");
    await run("ogr2ogr", [
      "-f",
      "GeoJSON",
      stateProjectedPath,
      STATE_BOUNDARY_PATH,
      "-t_srs",
      "EPSG:3857",
    ]);

    const outputMaps: Record<EcoregionLevel["key"], string> = {
      l3: join(temporaryDirectory, "ca_ecoregions_l3.webp"),
      l4: join(temporaryDirectory, "ca_ecoregions_l4.webp"),
    };
    for (const level of levels) {
      const coloredPath = temporaryCollections.get(level.key);
      if (!coloredPath) throw new Error(`Missing ${level.key.toUpperCase()} ecoregion data.`);
      const projectedPath = join(temporaryDirectory, `${level.key}_3857.geojson`);
      const rasterPath = join(temporaryDirectory, `${level.key}.tif`);
      await run("ogr2ogr", [
        "-f",
        "GeoJSON",
        projectedPath,
        coloredPath,
        "-t_srs",
        "EPSG:3857",
      ]);
      await writeRegionMap(
        projectedPath,
        stateProjectedPath,
        rasterPath,
        outputMaps[level.key],
        metadata,
      );
    }

    const metadataPath = join(temporaryDirectory, "ca_ecoregion_map.json");
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(outputMaps.l3, OUTPUT_PATHS.broadMap);
    await rename(outputMaps.l4, OUTPUT_PATHS.fineMap);
    await rename(metadataPath, OUTPUT_PATHS.metadata);

    console.log(
      `Generated Level 3 and Level 4 ecoregion maps (${metadata.width} × ${metadata.height} at ${RESOLUTION_METERS} m).`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await generateEcoregionMaps();
