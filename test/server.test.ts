import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { encodePolyline } from "../src/geo.js";
import { createServer } from "../src/server.js";
import type { LatLon } from "../src/types.js";

const line: LatLon[] = Array.from({ length: 11 }, (_, i) => [40.1777 + i * 0.001, 44.5126] as LatLon);

async function connect(fetchImpl: typeof fetch, keys: { google?: string; tomtom?: string }) {
  const server = createServer({ googleKey: keys.google, tomtomKey: keys.tomtom, fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("MCP server", () => {
  it("lists the tools", async () => {
    const client = await connect(fetch, {});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["compare_providers", "get_road_speed", "get_route", "get_traffic_incidents", "traffic_status"]);
  });

  it("get_route returns recommended route, hotspots and congested segments only", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          routes: [
            {
              duration: "600s",
              staticDuration: "400s",
              distanceMeters: 1112,
              routeLabels: ["DEFAULT_ROUTE"],
              polyline: { encodedPolyline: encodePolyline(line) },
              travelAdvisory: { speedReadingIntervals: [{ endPolylinePointIndex: 6, speed: "NORMAL" }, { startPolylinePointIndex: 6, endPolylinePointIndex: 10, speed: "TRAFFIC_JAM" }] },
            },
            { duration: "500s", staticDuration: "450s", distanceMeters: 1500, routeLabels: ["DEFAULT_ROUTE_ALTERNATE"], polyline: { encodedPolyline: encodePolyline(line) } },
          ],
        }),
      )) as unknown as typeof fetch;
    const client = await connect(fetchImpl, { google: "k" });
    const res = await client.callTool({ name: "get_route", arguments: { from: "republic_square", to: "cascade" } });
    const out = JSON.parse(text(res));
    expect(out.provider).toBe("google");
    expect(out.from).toBe("Republic Square");
    expect(out.recommended.index).toBe(1);
    expect(out.routes[0].route.segments).toHaveLength(1);
    expect(out.routes[0].route.segments[0].level).toBe("jam");
    expect(out.routes[0].hotspots[0]).toMatch(/^jammed/);
    expect(out.routes[0].route.geometry).toBeUndefined();
  });

  it("reports a clear error when no key is configured", async () => {
    const client = await connect(fetch, {});
    const res = await client.callTool({ name: "get_route", arguments: { from: "republic_square", to: "cascade" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/GOOGLE_MAPS_API_KEY/);
  });
});
