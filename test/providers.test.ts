import { describe, expect, it, vi } from "vitest";
import { encodePolyline } from "../src/geo.js";
import { buildGoogleBody, googleProvider, normalizeGoogle, streetFromInstruction } from "../src/providers/google.js";
import { flowLevel, normalizeIncidents, normalizeTomTom, tomtomProvider } from "../src/providers/tomtom.js";
import type { LatLon } from "../src/types.js";

// A synthetic 2.2 km line heading north from Republic Square (fixture data, not real traffic).
const line: LatLon[] = Array.from({ length: 21 }, (_, i) => [40.1777 + i * 0.001, 44.5126] as LatLon);

const googleFixture = {
  routes: [
    {
      duration: "900s",
      staticDuration: "540s",
      distanceMeters: 2224,
      description: "Mashtots Ave",
      routeLabels: ["DEFAULT_ROUTE"],
      polyline: { encodedPolyline: encodePolyline(line) },
      travelAdvisory: {
        speedReadingIntervals: [
          { endPolylinePointIndex: 5, speed: "NORMAL" }, // start index omitted = 0
          { startPolylinePointIndex: 5, endPolylinePointIndex: 12, speed: "TRAFFIC_JAM" },
          { startPolylinePointIndex: 12, endPolylinePointIndex: 15, speed: "SLOW" },
          { startPolylinePointIndex: 15, endPolylinePointIndex: 20, speed: "NORMAL" },
        ],
      },
      legs: [
        {
          steps: [
            { distanceMeters: 1000, startLocation: { latLng: { latitude: line[0][0], longitude: line[0][1] } }, navigationInstruction: { instructions: "Head north on Mashtots Ave" } },
            { distanceMeters: 1224, startLocation: { latLng: { latitude: line[10][0], longitude: line[10][1] } }, navigationInstruction: { instructions: "Turn left onto Baghramyan Ave\nPass by the park" } },
          ],
        },
      ],
    },
    {
      duration: "1000s",
      staticDuration: "700s",
      distanceMeters: 2500,
      routeLabels: ["DEFAULT_ROUTE_ALTERNATE"],
      polyline: { encodedPolyline: encodePolyline(line) },
    },
  ],
};

describe("google", () => {
  it("normalizes durations, delay, segments and street names", () => {
    const [r, alt] = normalizeGoogle(googleFixture, 3);
    expect(r.duration_s).toBe(900);
    expect(r.no_traffic_duration_s).toBe(540);
    expect(r.traffic_delay_s).toBe(360);
    expect(r.label).toBe("default");
    expect(r.segments.map((s) => [s.level, s.from_index, s.to_index, s.road])).toEqual([
      ["free", 0, 5, "Mashtots Ave"],
      ["jam", 5, 12, "Mashtots Ave"],
      ["slow", 12, 15, "Baghramyan Ave"],
      ["free", 15, 20, "Baghramyan Ave"],
    ]);
    expect(r.load.jam_m).toBeGreaterThan(700);
    expect(r.steps[1].instruction).toBe("Turn left onto Baghramyan Ave — Pass by the park");
    // A route without traffic data is reported as unknown, not free.
    expect(alt.label).toBe("alternative");
    expect(alt.segments).toHaveLength(1);
    expect(alt.segments[0].level).toBe("unknown");
  });

  it("extracts streets from instructions", () => {
    expect(streetFromInstruction("Turn right onto Tigran Mets Ave")).toBe("Tigran Mets Ave");
    expect(streetFromInstruction("Head south on Abovyan St\nRestricted usage road")).toBe("Abovyan St");
  });

  it("builds a traffic-aware request and sends the field mask", async () => {
    const body = buildGoogleBody({ from: { label: "a", coord: [40.17, 44.51] }, to: { label: "Mashtots Ave 10", address: "Mashtots Ave 10" }, alternatives: 2, language: "en" });
    expect(body).toMatchObject({
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: true,
      extraComputations: ["TRAFFIC_ON_POLYLINE"],
      destination: { address: "Mashtots Ave 10" },
    });
    expect(buildGoogleBody({ from: { label: "a", coord: [1, 2] }, to: { label: "b", coord: [1, 3] }, alternatives: 0, language: "en" }).routingPreference).toBe("TRAFFIC_AWARE_OPTIMAL");

    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(googleFixture)));
    const routes = await googleProvider("KEY", fetchMock as unknown as typeof fetch).route({
      from: { label: "a", coord: [40.17, 44.51] },
      to: { label: "b", coord: [40.19, 44.51] },
      alternatives: 0,
      language: "en",
    });
    expect(routes).toHaveLength(1);
    const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["X-Goog-FieldMask"]).toContain("routes.travelAdvisory.speedReadingIntervals");
    expect(headers["X-Goog-Api-Key"]).toBe("KEY");
  });

  it("surfaces HTTP errors without leaking the key", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"API key not valid"}}', { status: 400 }));
    await expect(
      googleProvider("SECRET", fetchMock as unknown as typeof fetch).route({ from: { label: "a", coord: [1, 2] }, to: { label: "b", coord: [1, 3] }, alternatives: 0, language: "en" }),
    ).rejects.toThrow(/\[google\] HTTP 400.*API key not valid/);
  });
});

const tomtomFixture = {
  routes: [
    {
      summary: { lengthInMeters: 2224, travelTimeInSeconds: 840, trafficDelayInSeconds: 300, noTrafficTravelTimeInSeconds: 520 },
      legs: [{ points: line.map(([latitude, longitude]) => ({ latitude, longitude })) }],
      sections: [
        { startPointIndex: 0, endPointIndex: 20, sectionType: "TRAVEL_MODE" },
        { startPointIndex: 4, endPointIndex: 9, sectionType: "TRAFFIC", simpleCategory: "JAM", magnitudeOfDelay: 3, effectiveSpeedInKmh: 8, delayInSeconds: 240 },
        { startPointIndex: 14, endPointIndex: 16, sectionType: "TRAFFIC", simpleCategory: "ROAD_WORK", magnitudeOfDelay: 1, effectiveSpeedInKmh: 25, delayInSeconds: 60 },
      ],
      guidance: {
        instructions: [
          { pointIndex: 0, street: "Mashtots Ave", message: "Leave from Mashtots Ave", routeOffsetInMeters: 0 },
          { pointIndex: 12, street: "Baghramyan Ave", message: "Turn left onto Baghramyan Ave", routeOffsetInMeters: 1335 },
          { pointIndex: 20, message: "You have arrived", routeOffsetInMeters: 2224 },
        ],
      },
    },
  ],
};

describe("tomtom", () => {
  it("normalizes traffic sections into a full congestion cover", () => {
    const [r] = normalizeTomTom(tomtomFixture, 1);
    expect(r.duration_s).toBe(840);
    expect(r.traffic_delay_s).toBe(300);
    expect(r.segments.map((s) => [s.level, s.cause, s.from_index, s.to_index, s.road, s.speed_kmh])).toEqual([
      ["free", undefined, 0, 4, "Mashtots Ave", undefined],
      ["jam", "jam", 4, 9, "Mashtots Ave", 8],
      ["free", undefined, 9, 14, "Mashtots Ave", undefined],
      ["slow", "roadworks", 14, 16, "Baghramyan Ave", 25],
      ["free", undefined, 16, 20, "Baghramyan Ave", undefined],
    ]);
    expect(r.via).toBe("via Mashtots Ave, Baghramyan Ave");
    expect(r.steps[0].distance_m).toBe(1335);
  });

  it("builds the calculateRoute URL with traffic sections and alternatives", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(tomtomFixture)));
    await tomtomProvider("TTKEY", fetchMock as unknown as typeof fetch).route({
      from: { label: "a", coord: [40.1777, 44.5126] },
      to: { label: "b", coord: [40.1473, 44.3959] },
      alternatives: 2,
      language: "en",
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/routing/1/calculateRoute/40.1777,44.5126:40.1473,44.3959/json");
    expect(url.searchParams.get("sectionType")).toBe("traffic");
    expect(url.searchParams.get("maxAlternatives")).toBe("2");
    expect(url.searchParams.get("computeTravelTimeFor")).toBe("all");
    expect(url.searchParams.get("traffic")).toBe("true");
  });

  it("classifies flow and incidents", () => {
    expect(flowLevel(0.9, false)).toBe("free");
    expect(flowLevel(0.5, false)).toBe("slow");
    expect(flowLevel(0.2, false)).toBe("jam");
    expect(flowLevel(1, true)).toBe("closed");
    const [inc] = normalizeIncidents({
      incidents: [
        {
          geometry: { type: "LineString", coordinates: [[44.51, 40.18], [44.52, 40.18]] },
          properties: { iconCategory: 1, magnitudeOfDelay: 2, events: [{ description: "Accident" }], from: "A", to: "B", delay: 120 },
        },
      ],
    });
    expect(inc).toMatchObject({ category: "accident", magnitude: "moderate", description: "Accident", at: [40.18, 44.51], delay_s: 120 });
  });
});
