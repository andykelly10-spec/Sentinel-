import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv";
import { parseSitesCsv } from "../src/sites";

describe("parseCsv", () => {
  it("handles quotes, embedded commas and newlines, and both line endings", () => {
    expect(parseCsv('﻿a,b\r\n"1, Main St","say ""hi"""\n"two\nlines",x\n\n')).toEqual([
      ["a", "b"],
      ["1, Main St", 'say "hi"'],
      ["two\nlines", "x"],
    ]);
  });
});

describe("parseSitesCsv", () => {
  it("accepts common column names and flags rows without coordinates as estimates", () => {
    const { sites, skipped } = parseSitesCsv("Building,Street,Town,Lat,Lng,Keywords\nHQ,1 Main St,Burbank,34.15,-118.33,\"media district, toluca lake\"\nAnnex,,Atlanta,,,");
    expect(skipped).toEqual([]);
    expect(sites).toEqual([
      { name: "HQ", address: "1 Main St", city: "Burbank", country: "", lat: 34.15, lon: -118.33, area: "", keywords: "media district, toluca lake", priority: false, approximate: false },
      { name: "Annex", address: "", city: "Atlanta", country: "", lat: null, lon: null, area: "", keywords: "", priority: false, approximate: true },
    ]);
  });

  it("treats out-of-range coordinates as missing and explains unusable files", () => {
    expect(parseSitesCsv("name,city,lat,lon\nHQ,Burbank,340,-118").sites[0]).toMatchObject({ lat: null, lon: null, approximate: true });
    expect(() => parseSitesCsv("")).toThrow(/empty/);
    expect(() => parseSitesCsv("city,country\nLondon,UK")).toThrow(/"name"/);
  });
});
