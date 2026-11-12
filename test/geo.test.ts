import { describe, expect, it } from "vitest";
import { buildSegments, decodePolyline, encodePolyline, parsePlace, summarizeLoad } from "../src/geo.js";
import type { LatLon } from "../src/types.js";

describe("polyline", () => {
  it("decodes Google's reference example", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });
  it("round-trips", () => {
    const pts: LatLon[] = [
      [40.1777, 44.5126],
      [40.1801, 44.5133],
      [40.1863, 44.5152],
    ];
    expect(decodePolyline(encodePolyline(pts))).toEqual(pts);
  });
});

describe("parsePlace", () => {
  it("parses lat,lon and swaps lon,lat for Yerevan", () => {
    expect(parsePlace("40.1777, 44.5126").coord).toEqual([40.1777, 44.5126]);
    expect(parsePlace("44.5126,40.1777").coord).toEqual([40.1777, 44.5126]);
  });
  it("resolves landmarks by key and alias", () => {
    expect(parsePlace("zvartnots_airport").label).toMatch(/Zvartnots/);
    expect(parsePlace("Republic Square").coord).toEqual([40.1777, 44.5126]);
  });
  it("passes free text through as an address", () => {
    expect(parsePlace("Mashtots Ave 10")).toEqual({ label: "Mashtots Ave 10", address: "Mashtots Ave 10" });
  });
});

describe("buildSegments", () => {
  const pts: LatLon[] = Array.from({ length: 11 }, (_, i) => [40.17 + i * 0.001, 44.5] as LatLon);

  it("fills gaps, merges same-level neighbours and covers the whole line", () => {
    const segs = buildSegments(
      pts,
      [
        { from: 0, to: 2, level: "free" },
        { from: 2, to: 4, level: "free" },
        { from: 4, to: 6, level: "jam" },
        { from: 8, to: 10, level: "slow" },
      ],
      "unknown",
      (i) => (i < 5 ? "Mashtots Ave" : "Baghramyan Ave"),
    );
    expect(segs.map((s) => [s.level, s.from_index, s.to_index, s.road])).toEqual([
      ["free", 0, 4, "Mashtots Ave"],
      ["jam", 4, 6, "Mashtots Ave"],
      ["unknown", 6, 8, "Baghramyan Ave"],
      ["slow", 8, 10, "Baghramyan Ave"],
    ]);
    const total = segs.reduce((a, s) => a + s.length_m, 0);
    expect(total).toBeGreaterThan(1100);
    expect(total).toBeLessThan(1125); // 10 × ~111 m
    const load = summarizeLoad(segs);
    expect(load.congested_share).toBeCloseTo(0.4, 1);
  });

  it("does not merge stretches that carry their own speed/delay", () => {
    const segs = buildSegments(
      pts,
      [
        { from: 1, to: 3, level: "slow", speed_kmh: 20 },
        { from: 3, to: 5, level: "slow", speed_kmh: 12 },
      ],
      "free",
      () => undefined,
    );
    expect(segs.map((s) => s.level)).toEqual(["free", "slow", "slow", "free"]);
  });
});
