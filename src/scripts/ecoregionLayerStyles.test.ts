import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { readEcoregionLayerStyles } from "./ecoregionLayerStyles";

describe("EPA ecoregion LYR colors", () => {
  it("extracts Level 3 CMYK styles and converts them to RGB", async () => {
    const styles = await readEcoregionLayerStyles(
      fileURLToPath(new URL("../../public/data/features/ca_eco_l3.lyr", import.meta.url)),
      "l3",
    );

    expect(styles.byCode.size).toBe(12);
    expect(styles.byCode.get("6")).toEqual({
      name: "Southern and Central California Chaparral and Oak Woodlands",
      red: 212,
      green: 163,
      blue: 0,
    });
    expect(styles.defaultStyle).toEqual({
      name: "<all other values>",
      red: 255,
      green: 255,
      blue: 255,
    });
  });

  it("extracts every Level 4 class and its configured color", async () => {
    const styles = await readEcoregionLayerStyles(
      fileURLToPath(new URL("../../public/data/features/ca_eco_l4.lyr", import.meta.url)),
      "l4",
    );

    expect(styles.byCode.size).toBe(180);
    expect(styles.byCode.get("13aa")).toEqual({
      name: "Sierra Nevada-Influenced Semiarid Hills and Basins",
      red: 232,
      green: 219,
      blue: 255,
    });
  });
});
