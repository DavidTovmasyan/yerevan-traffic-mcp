import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fmtDuration, recommend, routeHeadline, viewRoute, type SegmentMode } from "./format.js";
import { haversine, parsePlace, YEREVAN_BBOX, YEREVAN_PLACES } from "./geo.js";
import { googleProvider } from "./providers/google.js";
import { tomtomProvider, type TomTomClient } from "./providers/tomtom.js";
import type { FetchLike, LatLon, ProviderId, Route, RouteProvider, RouteRequest } from "./types.js";

export interface ServerConfig {
  googleKey?: string;
  tomtomKey?: string;
  fetchImpl?: FetchLike;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

const locationDesc =
  'Where: "lat,lon" (e.g. "40.1777,44.5126"), a built-in landmark (republic_square, zvartnots_airport, cascade, opera, railway_station) or a free-text address in Yerevan.';

export function createServer(cfg: ServerConfig): McpServer {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const providers: Partial<Record<ProviderId, RouteProvider>> = {};
  if (cfg.googleKey) providers.google = googleProvider(cfg.googleKey, fetchImpl);
  let tomtom: TomTomClient | undefined;
  if (cfg.tomtomKey) providers.tomtom = tomtom = tomtomProvider(cfg.tomtomKey, fetchImpl);

  const configured = () => Object.keys(providers) as ProviderId[];
  const pick = (p: "auto" | ProviderId): RouteProvider => {
    if (p === "auto") {
      const first = providers.google ?? providers.tomtom;
      if (!first) throw new Error("No provider configured. Set GOOGLE_MAPS_API_KEY and/or TOMTOM_API_KEY.");
      return first;
    }
    const prov = providers[p];
    if (!prov) throw new Error(`Provider "${p}" is not configured (set ${p === "google" ? "GOOGLE_MAPS_API_KEY" : "TOMTOM_API_KEY"}).`);
    return prov;
  };
  const needTomTom = () => {
    if (!tomtom) throw new Error("This tool needs TomTom traffic data: set TOMTOM_API_KEY.");
    return tomtom;
  };

  const server = new McpServer({ name: "yerevan-traffic", version: "0.1.0" });

  server.registerTool(
    "get_route",
    {
      title: "Traffic-aware route A → B",
      description:
        "Navigator-style driving route in Yerevan with live traffic: ETA, delay caused by traffic, up to 3 alternative routes, " +
        "and congestion per stretch of road (free / slow / jam / closed) with street names. The recommended route is the fastest one.",
      inputSchema: {
        from: z.string().describe(`Start. ${locationDesc}`),
        to: z.string().describe(`Destination. ${locationDesc}`),
        provider: z.enum(["auto", "google", "tomtom"]).default("auto").describe("Traffic data source. auto = Google if configured, else TomTom."),
        alternatives: z.number().int().min(0).max(3).default(2).describe("Alternative routes to request besides the main one."),
        depart_at: z.string().optional().describe("ISO 8601 departure time for a predicted ETA (e.g. 2026-11-13T08:30:00+04:00). Omit for now."),
        segments: z
          .enum(["congested", "all", "none"])
          .default("congested")
          .describe("Which stretches to list: only slow/jammed/closed ones (default), every stretch, or none."),
        include_steps: z.boolean().default(false).describe("Include turn-by-turn instructions."),
        include_geometry: z.boolean().default(false).describe("Include the full route polyline as [lat,lon] points (large)."),
        language: z.string().default("en").describe("Language for instructions/street names: en, ru, hy."),
      },
    },
    async (a) => {
      try {
        const prov = pick(a.provider);
        const req: RouteRequest = {
          from: parsePlace(a.from),
          to: parsePlace(a.to),
          alternatives: a.alternatives,
          departAt: a.depart_at,
          language: a.language,
        };
        const routes = await prov.route(req);
        const best = recommend(routes)!;
        const opts = { segments: a.segments as SegmentMode, steps: a.include_steps, geometry: a.include_geometry };
        return json({
          provider: prov.id,
          from: req.from.label,
          to: req.to.label,
          recommended: { index: best.index, why: whyBest(best, routes) },
          routes: routes.map((r) => viewRoute(r, opts)),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "compare_providers",
    {
      title: "Compare Google vs TomTom on one trip",
      description:
        "Ask every configured provider for the same trip and put ETAs, traffic delay and congestion side by side. " +
        "Use it to check which provider actually has live traffic for Yerevan (e.g. compare with Yandex Navigator at rush hour).",
      inputSchema: {
        from: z.string().describe(`Start. ${locationDesc}`),
        to: z.string().describe(`Destination. ${locationDesc}`),
        depart_at: z.string().optional().describe("ISO 8601 departure time. Omit for now."),
      },
    },
    async (a) => {
      try {
        const ids = configured();
        if (!ids.length) throw new Error("No provider configured. Set GOOGLE_MAPS_API_KEY and/or TOMTOM_API_KEY.");
        const req: RouteRequest = { from: parsePlace(a.from), to: parsePlace(a.to), alternatives: 0, departAt: a.depart_at, language: "en" };
        const results = await Promise.all(
          ids.map(async (id) => {
            try {
              const [r] = await providers[id]!.route(req);
              return { provider: id, ...compareRow(r) };
            } catch (e) {
              return { provider: id, error: (e as Error).message };
            }
          }),
        );
        return json({ from: req.from.label, to: req.to.label, results });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_road_speed",
    {
      title: "Live speed on the road at a point",
      description: "Current vs free-flow speed on the road nearest to a point (TomTom Traffic Flow). Answers 'is X street jammed right now?'.",
      inputSchema: { at: z.string().describe(locationDesc) },
    },
    async (a) => {
      try {
        const tt = needTomTom();
        const place = parsePlace(a.at);
        const coord = place.coord ?? (await tt.geocode(place.address ?? place.label)).coord!;
        const { geometry, ...flow } = await tt.flow(coord);
        return json({ at: place.label, ...flow, segment_start: geometry[0], segment_end: geometry[geometry.length - 1] });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_traffic_incidents",
    {
      title: "Traffic incidents in Yerevan",
      description: "Current accidents, jams, road works and closures (TomTom Incidents). Defaults to the whole of Yerevan, or a radius around a point.",
      inputSchema: {
        near: z.string().optional().describe(`Optional centre. ${locationDesc}`),
        radius_km: z.number().min(0.2).max(30).default(2).describe("Radius around `near`."),
        language: z.string().default("en"),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async (a) => {
      try {
        const tt = needTomTom();
        let bbox = YEREVAN_BBOX;
        let center: LatLon | undefined;
        if (a.near) {
          const place = parsePlace(a.near);
          center = place.coord ?? (await tt.geocode(place.address ?? place.label)).coord!;
          const dLat = a.radius_km / 111.32;
          const dLon = a.radius_km / (111.32 * Math.cos((center[0] * Math.PI) / 180));
          bbox = [center[1] - dLon, center[0] - dLat, center[1] + dLon, center[0] + dLat];
        }
        let incidents = await tt.incidents(bbox, a.language);
        if (center) incidents = incidents.filter((i) => !i.at || haversine(i.at, center!) <= a.radius_km * 1000);
        incidents.sort((x, y) => (y.delay_s ?? 0) - (x.delay_s ?? 0));
        return json({ count: incidents.length, incidents: incidents.slice(0, a.limit) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "traffic_status",
    {
      title: "Configured providers and landmarks",
      description: "Which traffic providers are configured, and the built-in Yerevan landmarks usable as locations.",
      inputSchema: {},
    },
    async () =>
      json({
        providers: { google: !!providers.google, tomtom: !!providers.tomtom },
        default_provider: providers.google ? "google" : providers.tomtom ? "tomtom" : null,
        landmarks: Object.entries(YEREVAN_PLACES).map(([id, p]) => ({ id, label: p.label, coord: p.coord })),
      }),
  );

  return server;
}

function compareRow(r: Route) {
  return {
    eta: fmtDuration(r.duration_s),
    duration_s: r.duration_s,
    no_traffic_duration_s: r.no_traffic_duration_s,
    traffic_delay_s: r.traffic_delay_s,
    distance_m: r.distance_m,
    congested_share: r.load.congested_share,
    jam_m: r.load.jam_m,
    slow_m: r.load.slow_m,
    headline: routeHeadline(r),
    // No delay and zero congestion at rush hour usually means no live data for the area.
    live_traffic_signal: (r.traffic_delay_s ?? 0) > 0 || r.load.congested_share > 0,
  };
}

function whyBest(best: Route, all: Route[]): string {
  if (all.length < 2) return "only route returned";
  const others = all.filter((r) => r !== best);
  const saving = Math.min(...others.map((r) => r.duration_s)) - best.duration_s;
  return `fastest with current traffic${saving > 30 ? `, ${fmtDuration(saving)} quicker than the next option` : ""}`;
}
