import { readFile } from "node:fs/promises";

const END_OF_CHAIN = 0xffff_fffe;
const FREE_SECTOR = 0xffff_ffff;
const MAX_REGULAR_SECTOR = 0xffff_fff0;
const CLASS_SYMBOL_RECORD_BYTES = 360;
const DEFAULT_SYMBOL_REFERENCE_BYTES = 46;
const SYMBOL_CMYK_OFFSET = 0x14a;
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export type EcoregionLayerStyle = {
  name: string;
  red: number;
  green: number;
  blue: number;
};

export type EcoregionLayerStyles = {
  byCode: Map<string, EcoregionLayerStyle>;
  defaultStyle: EcoregionLayerStyle;
};

type DirectoryEntry = {
  name: string;
  type: number;
  firstSector: number;
  size: number;
};

type Utf16String = { offset: number; value: string };

function readCompoundStream(file: Uint8Array, streamName: string): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const requireRange = (offset: number, length: number, description: string) => {
    if (offset < 0 || length < 0 || offset + length > file.byteLength) {
      throw new Error(`The ecoregion layer file has an invalid ${description}.`);
    }
  };
  const readUint16 = (offset: number) => {
    requireRange(offset, 2, "header");
    return view.getUint16(offset, true);
  };
  const readUint32 = (offset: number) => {
    requireRange(offset, 4, "header");
    return view.getUint32(offset, true);
  };
  const readSectorSize = (sectorId: number, sectorSize: number) => {
    if (sectorId >= MAX_REGULAR_SECTOR) {
      throw new Error("The ecoregion layer file has an invalid sector reference.");
    }
    const offset = (sectorId + 1) * sectorSize;
    requireRange(offset, sectorSize, "sector chain");
    return file.subarray(offset, offset + sectorSize);
  };
  const readChain = (
    firstSector: number,
    allocationTable: number[],
    sectorSize: number,
    byteLimit = Number.POSITIVE_INFINITY,
  ) => {
    const chunks: Uint8Array[] = [];
    const visited = new Set<number>();
    let sectorId = firstSector;
    let byteCount = 0;
    while (
      sectorId !== END_OF_CHAIN &&
      sectorId !== FREE_SECTOR &&
      byteCount < byteLimit
    ) {
      if (
        sectorId >= allocationTable.length ||
        sectorId >= MAX_REGULAR_SECTOR ||
        visited.has(sectorId)
      ) {
        throw new Error("The ecoregion layer file contains a broken sector chain.");
      }
      visited.add(sectorId);
      chunks.push(readSectorSize(sectorId, sectorSize));
      byteCount += sectorSize;
      const nextSector = allocationTable[sectorId];
      if (nextSector === undefined) {
        throw new Error("The ecoregion layer file contains a broken allocation table.");
      }
      sectorId = nextSector;
    }
    const bytes = new Uint8Array(Math.min(byteCount, byteLimit));
    let offset = 0;
    for (const chunk of chunks) {
      const length = Math.min(chunk.length, bytes.length - offset);
      if (length <= 0) break;
      bytes.set(chunk.subarray(0, length), offset);
      offset += length;
    }
    return bytes;
  };

  if (!OLE_SIGNATURE.every((byte, index) => file[index] === byte)) {
    throw new Error("The ecoregion layer file is not an ArcMap OLE layer.");
  }
  const majorVersion = readUint16(0x1a);
  const sectorShift = readUint16(0x1e);
  const miniSectorShift = readUint16(0x20);
  if (majorVersion !== 3 || sectorShift !== 9 || miniSectorShift !== 6) {
    throw new Error("The ecoregion layer file uses an unsupported OLE format.");
  }
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  const numberOfFatSectors = readUint32(0x2c);
  if (numberOfFatSectors > 109) {
    throw new Error("The ecoregion layer file uses an unsupported FAT layout.");
  }
  const fatSectorIds = Array.from({ length: 109 }, (_, index) =>
    readUint32(0x4c + index * 4)
  ).filter((sectorId) => sectorId < MAX_REGULAR_SECTOR);
  if (fatSectorIds.length !== numberOfFatSectors) {
    throw new Error("The ecoregion layer file has an incomplete FAT.");
  }
  const fat = fatSectorIds.flatMap((sectorId) => {
    const sector = readSectorSize(sectorId, sectorSize);
    return Array.from(
      { length: sectorSize / 4 },
      (_, index) => new DataView(sector.buffer, sector.byteOffset, sector.byteLength)
        .getUint32(index * 4, true),
    );
  });
  const readRegularStream = (firstSector: number, size: number) =>
    readChain(firstSector, fat, sectorSize, size);
  const directoryBytes = readRegularStream(readUint32(0x30), Number.POSITIVE_INFINITY);
  const directory: DirectoryEntry[] = [];
  for (let offset = 0; offset + 128 <= directoryBytes.length; offset += 128) {
    const entryView = new DataView(
      directoryBytes.buffer,
      directoryBytes.byteOffset + offset,
      128,
    );
    const type = entryView.getUint8(66);
    if (type === 0) continue;
    const nameLength = entryView.getUint16(64, true);
    if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) {
      throw new Error("The ecoregion layer file has an invalid directory entry.");
    }
    const name = new TextDecoder("utf-16le").decode(
      directoryBytes.subarray(offset, offset + nameLength - 2),
    );
    const size = Number(entryView.getBigUint64(120, true));
    if (!Number.isSafeInteger(size)) {
      throw new Error("The ecoregion layer file contains an oversized stream.");
    }
    directory.push({
      name,
      type,
      firstSector: entryView.getUint32(116, true),
      size,
    });
  }
  const root = directory.find((entry) => entry.type === 5);
  const layer = directory.find((entry) => entry.type === 2 && entry.name === streamName);
  if (!root || !layer) {
    throw new Error(`The ecoregion layer file is missing its ${streamName} stream.`);
  }
  const miniStream = readRegularStream(root.firstSector, root.size);
  const numberOfMiniFatSectors = readUint32(0x40);
  const miniFatBytes = readRegularStream(
    readUint32(0x3c),
    numberOfMiniFatSectors * sectorSize,
  );
  const miniFatView = new DataView(
    miniFatBytes.buffer,
    miniFatBytes.byteOffset,
    miniFatBytes.byteLength,
  );
  const miniFat = Array.from(
    { length: miniFatBytes.length / 4 },
    (_, index) => miniFatView.getUint32(index * 4, true),
  );
  if (layer.size >= readUint32(0x38)) {
    return readRegularStream(layer.firstSector, layer.size);
  }

  const chunks: Uint8Array[] = [];
  const visited = new Set<number>();
  let miniSectorId = layer.firstSector;
  let byteCount = 0;
  while (miniSectorId !== END_OF_CHAIN && miniSectorId !== FREE_SECTOR && byteCount < layer.size) {
    if (
      miniSectorId >= miniFat.length ||
      visited.has(miniSectorId) ||
      (miniSectorId + 1) * miniSectorSize > miniStream.length
    ) {
      throw new Error("The ecoregion layer file contains a broken mini-sector chain.");
    }
    visited.add(miniSectorId);
    const start = miniSectorId * miniSectorSize;
    chunks.push(miniStream.subarray(start, start + miniSectorSize));
    byteCount += miniSectorSize;
    const nextSector = miniFat[miniSectorId];
    if (nextSector === undefined) {
      throw new Error("The ecoregion layer file contains a broken mini allocation table.");
    }
    miniSectorId = nextSector;
  }
  const layerStream = new Uint8Array(layer.size);
  let offset = 0;
  for (const chunk of chunks) {
    const length = Math.min(chunk.length, layerStream.length - offset);
    if (length <= 0) break;
    layerStream.set(chunk.subarray(0, length), offset);
    offset += length;
  }
  if (offset !== layer.size) {
    throw new Error(`The ecoregion layer file has an incomplete ${streamName} stream.`);
  }
  return layerStream;
}

function readUtf16AsciiStrings(bytes: Uint8Array): Utf16String[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const strings: Utf16String[] = [];
  let start = -1;
  let value = "";
  const finish = () => {
    if (start >= 0 && value.length >= 3) strings.push({ offset: start, value });
    start = -1;
    value = "";
  };
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const code = view.getUint16(offset, true);
    if (code >= 0x20 && code <= 0x7e) {
      if (start < 0) start = offset;
      value += String.fromCharCode(code);
    } else {
      finish();
    }
  }
  finish();
  return strings;
}

function cmykToStyle(cmyk: Uint8Array, name: string): EcoregionLayerStyle {
  const [cyan, magenta, yellow, black] = cmyk;
  if (
    cyan === undefined || magenta === undefined || yellow === undefined || black === undefined ||
    Math.max(cyan, magenta, yellow, black) > 100
  ) {
    throw new Error(`The LYR color for ${name} is not valid CMYK percentage data.`);
  }
  const scale = 255 * (1 - black / 100);
  return {
    name,
    red: Math.round(scale * (1 - cyan / 100)),
    green: Math.round(scale * (1 - magenta / 100)),
    blue: Math.round(scale * (1 - yellow / 100)),
  };
}

export async function readEcoregionLayerStyles(
  path: string,
  level: "l3" | "l4",
): Promise<EcoregionLayerStyles> {
  const bytes = readCompoundStream(await readFile(path), "Layer");
  const strings = readUtf16AsciiStrings(bytes);
  const defaultLabel = strings.find((entry) => entry.value === "<all other values>");
  if (!defaultLabel) {
    throw new Error(`${level.toUpperCase()} LYR file is missing its default value symbol.`);
  }
  const classEntries = strings.flatMap((entry) => {
    const match = /^([A-Za-z0-9]+)\s{2,}(.+)$/.exec(entry.value);
    return match?.[1] && match[2]
      ? [{ ...entry, code: match[1], name: match[2].trim() }]
      : [];
  });
  if (classEntries.length < 2) {
    throw new Error(`${level.toUpperCase()} LYR file has no unique-value classes.`);
  }
  const defaultColorOffset = defaultLabel.offset +
    (defaultLabel.value.length + 1) * 2 +
    SYMBOL_CMYK_OFFSET;
  const defaultStyle = cmykToStyle(
    bytes.subarray(defaultColorOffset, defaultColorOffset + 4),
    "<all other values>",
  );
  const styles = new Map<string, EcoregionLayerStyle>();
  for (let index = 0; index < classEntries.length; index += 1) {
    const entry = classEntries[index];
    if (!entry) continue;
    if (styles.has(entry.code)) break;
    const next = classEntries[index + 1];
    if (!next) {
      throw new Error(`${level.toUpperCase()} LYR class ${entry.code} has no symbol record.`);
    }
    const stringEnd = entry.offset + (entry.value.length + 1) * 2;
    const recordSize = next.offset - stringEnd;
    let style: EcoregionLayerStyle;
    if (recordSize === CLASS_SYMBOL_RECORD_BYTES) {
      const colorOffset = stringEnd + SYMBOL_CMYK_OFFSET;
      style = cmykToStyle(
        bytes.subarray(colorOffset, colorOffset + 4),
        entry.name,
      );
    } else if (
      recordSize === DEFAULT_SYMBOL_REFERENCE_BYTES &&
      styles.has(next.code)
    ) {
      style = { ...defaultStyle, name: entry.name };
    } else {
      throw new Error(
        `${level.toUpperCase()} LYR class ${entry.code} has an unsupported ${recordSize}-byte symbol record.`,
      );
    }
    styles.set(entry.code, style);
  }
  if (styles.size === 0) {
    throw new Error(`${level.toUpperCase()} LYR file contains no usable symbol colors.`);
  }
  return { byCode: styles, defaultStyle };
}
