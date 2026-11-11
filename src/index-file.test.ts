import { describe, expect, it } from "vite-plus/test";
import { decodeIndex, encodeIndex, type IndexSite } from "./index-file.ts";

const site = (id: number, fields: Partial<IndexSite> = {}): IndexSite => ({
  content_id: `NUR${id}`,
  category_id: "11",
  name: `Nuraghe ${id}`,
  comune: "Barumini",
  localita: "",
  regione: "Marmilla",
  lon: 8.99012,
  lat: 39.7058,
  ...fields,
});

describe("index file", () => {
  it("decodes to the same sites, sorted by id", () => {
    const sites = [
      site(5023),
      site(17),
      site(4974, { comune: "Gesturi", lon: 9.1, lat: 39.65432 }),
    ];
    const decoded = decodeIndex(encodeIndex(sites, "2026-11-11T00:00:00.000Z"));
    expect(decoded).toEqual([
      site(17),
      site(4974, { comune: "Gesturi", lon: 9.1, lat: 39.65432 }),
      site(5023),
    ]);
  });

  it("writes repeated values once, ids as differences, coordinates as integers", () => {
    const file = encodeIndex([site(10), site(12), site(15, { comune: "Gesturi" })], "");
    expect(file.ids).toEqual([10, 2, 3]);
    expect(file.comune).toEqual({ values: ["Barumini", "Gesturi"], of: [0, 0, 1] });
    expect(file.lon).toEqual([899012, 899012, 899012]);
  });

  it("refuses what it can't write exactly", () => {
    expect(() => encodeIndex([site(1, { content_id: "X1" })], "")).toThrow(/not NUR/);
    expect(() => encodeIndex([site(1, { lon: 8.123456 })], "")).toThrow(/5 decimals/);
  });
});
