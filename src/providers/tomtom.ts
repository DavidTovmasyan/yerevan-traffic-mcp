/**
 * TomTom Routing API (calculateRoute, sectionType=traffic), Traffic Flow and Traffic Incidents v5,
 * and Search geocoding for free-text places.
 * Docs: https://docs.tomtom.com/routing-api/documentation/tomtom-maps/calculate-route
 */
import { buildSegments, round, summarizeLoad, YEREVAN_CENTER, type RawInterval } from "../geo.js";
import { fetchJson, ProviderError } from "../http.js";
import type { FetchLike, LatLon, Level, Place, Route, RouteProvider, RouteRequest, Segment, Step } from "../types.js";

const BASE = "https://api.tomtom.com";

export interface TomTomSection {
  startPointIndex: number;
  endPointIndex: number;
  sectionType: string;
  simpleCategory?: string;
  magnitudeOfDelay?: number;
  effectiveSpeedInKmh?: number;
  delayInSeconds?: number;
}

export interface TomTomRoute {
  summary: {
    lengthInMeters: number;
    travelTimeInSeconds: number;
    trafficDelayInSeconds?: number;
    noTrafficTravelTimeInSeconds?: number;
    historicTrafficTravelTimeInSeconds?: number;
    liveTrafficIncidentsTravelTimeInSeconds?: number;
  };
  legs?: { points?: { latitude: number; longitude: number }[] }[];
  sections?: TomTomSection[];
  guidance?: {
    instructions?: { pointIndex?: number; street?: string; roadNumbers?: string[]; message?: string; routeOffsetInMeters?: number }[];
  };
}

export interface TomTomRouteResponse {
  routes?: TomTomRoute[];
}

/** TomTom marks only congested stretches; map their category and delay magnitude to a level. */
export function tomtomLevel(s: TomTomSection): { level: Level; cause: Segment["cause"] } {
  const mag = s.magnitudeOfDelay ?? 0;
  switch (s.simpleCategory) {
    case "ROAD_CLOSURE":
      return { level: "closed", cause: "closure" };
    case "JAM":
      return { level: mag >= 3 ? "jam" : "slow", cause: "jam" };
    case "ROAD_WORK":
      return { level: mag >= 3 ? "jam" : "slow", cause: "roadworks" };
    default:
      return { level: mag >= 3 ? "jam" : "slow", cause: "other" };
  }
}

/** Point lists of all legs, concatenated with the shared leg-boundary point de-duplicated. */
function routePoints(r: TomTomRoute): LatLon[] {
  const pts: LatLon[] = [];
  for (const leg of r.legs ?? []) {
    for (const p of leg.points ?? []) {
      const ll: LatLon = [p.latitude, p.longitude];
      const prev = pts[pts.length - 1];
      if (!prev || prev[0] !== ll[0] || prev[1] !== ll[1]) pts.push(ll);
    }
  }
  return pts;
}

export function normalizeTomTom(resp: TomTomRouteResponse, maxRoutes: number): Route[] {
  return (resp.routes ?? []).slice(0, maxRoutes).map((r, index) => {
    const points = routePoints(r);
    const instr = (r.guidance?.instructions ?? []).filter((i) => i.pointIndex !== undefined);

    const roadAt = (i: number) => {
      let road: string | undefined;
      for (const ins of instr) {
        if ((ins.pointIndex ?? 0) > i) break;
        const name = ins.street || ins.roadNumbers?.join("/");
        if (name) road = name;
      }
      return road;
    };

    const intervals: RawInterval[] = (r.sections ?? [])
      .filter((s) => s.sectionType === "TRAFFIC")
      .map((s) => {
        const { level, cause } = tomtomLevel(s);
        return {
          from: s.startPointIndex,
          to: s.endPointIndex,
          level,
          cause,
          speed_kmh: s.effectiveSpeedInKmh,
          delay_s: s.delayInSeconds,
        };
      });
    // Stretches without a TRAFFIC section have no reported congestion.
    const segments = buildSegments(points, intervals, "free", roadAt);

    const steps: Step[] = (r.guidance?.instructions ?? [])
      .filter((i) => i.message)
      .map((i, k, all) => ({
        instruction: i.message!,
        distance_m:
          all[k + 1]?.routeOffsetInMeters !== undefined && i.routeOffsetInMeters !== undefined
            ? all[k + 1].routeOffsetInMeters! - i.routeOffsetInMeters
            : undefined,
      }));

    const s = r.summary;
    return {
      provider: "tomtom",
      index,
      label: index === 0 ? "default" : "alternative",
      via: viaFromSegments(segments),
      duration_s: s.travelTimeInSeconds,
      no_traffic_duration_s: s.noTrafficTravelTimeInSeconds,
      traffic_delay_s: s.trafficDelayInSeconds,
      distance_m: s.lengthInMeters,
      load: summarizeLoad(segments),
      segments,
      steps,
      geometry: points,
    } satisfies Route;
  });
}

/** "via Mashtots Ave, Arshakunyats Ave": the two streets covering the most distance. */
function viaFromSegments(segments: Segment[]): string | undefined {
  const byRoad = new Map<string, number>();
  for (const s of segments) if (s.road) byRoad.set(s.road, (byRoad.get(s.road) ?? 0) + s.length_m);
  const top = [...byRoad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => r);
  return top.length ? `via ${top.join(", ")}` : undefined;
}

export interface TomTomClient extends RouteProvider {
  geocode(query: string): Promise<Place>;
  flow(at: LatLon): Promise<FlowReading>;
  incidents(bbox: [number, number, number, number], language: string): Promise<Incident[]>;
}

export interface FlowReading {
  road_class?: string;
  current_speed_kmh: number;
  free_flow_speed_kmh: number;
  /** current / free-flow speed, 1 = no congestion. */
  speed_ratio: number;
  level: Level;
  current_travel_time_s: number;
  free_flow_travel_time_s: number;
  confidence: number;
  road_closed: boolean;
  geometry: LatLon[];
}

export function flowLevel(ratio: number, closed: boolean): Level {
  if (closed) return "closed";
  if (ratio >= 0.75) return "free";
  if (ratio >= 0.4) return "slow";
  return "jam";
}

export interface Incident {
  category: string;
  magnitude: string;
  description?: string;
  from?: string;
  to?: string;
  roads?: string[];
  length_m?: number;
  delay_s?: number;
  start_time?: string;
  end_time?: string;
  /** First coordinate of the incident geometry. */
  at?: LatLon;
}

export const ICON_CATEGORY: Record<number, string> = {
  0: "unknown",
  1: "accident",
  2: "fog",
  3: "dangerous conditions",
  4: "rain",
  5: "ice",
  6: "jam",
  7: "lane closed",
  8: "road closed",
  9: "road works",
  10: "wind",
  11: "flooding",
  14: "broken down vehicle",
};
export const MAGNITUDE: Record<number, string> = { 0: "unknown", 1: "minor", 2: "moderate", 3: "major", 4: "undefined" };

interface IncidentResponse {
  incidents?: {
    geometry?: { type: string; coordinates: unknown };
    properties?: {
      iconCategory?: number;
      magnitudeOfDelay?: number;
      events?: { description?: string }[];
      from?: string;
      to?: string;
      roadNumbers?: string[];
      length?: number;
      delay?: number;
      startTime?: string;
      endTime?: string;
    };
  }[];
}

export function normalizeIncidents(resp: IncidentResponse): Incident[] {
  return (resp.incidents ?? []).map((inc) => {
    const p = inc.properties ?? {};
    const c = inc.geometry?.coordinates as unknown;
    // GeoJSON is [lon, lat]; Point = [lon,lat], LineString = [[lon,lat], ...]
    const first = Array.isArray(c) ? (Array.isArray(c[0]) ? (c[0] as number[]) : (c as number[])) : undefined;
    const out: Incident = {
      category: ICON_CATEGORY[p.iconCategory ?? 0] ?? `category ${p.iconCategory}`,
      magnitude: MAGNITUDE[p.magnitudeOfDelay ?? 0] ?? "unknown",
      description: p.events?.map((e) => e.description).filter(Boolean).join("; ") || undefined,
      from: p.from,
      to: p.to,
      roads: p.roadNumbers?.length ? p.roadNumbers : undefined,
      length_m: p.length !== undefined ? Math.round(p.length) : undefined,
      delay_s: p.delay,
      start_time: p.startTime,
      end_time: p.endTime,
      at: first && first.length >= 2 ? [first[1], first[0]] : undefined,
    };
    return out;
  });
}

const INCIDENT_FIELDS =
  "{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,delay,roadNumbers}}}";

export function tomtomProvider(apiKey: string, fetchImpl: FetchLike = fetch): TomTomClient {
  const get = <T>(path: string, params: Record<string, string | number | boolean | string[]>) => {
    const qs = new URLSearchParams({ key: apiKey });
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else qs.set(k, String(v));
    }
    return fetchJson<T>("tomtom", fetchImpl, `${BASE}${path}?${qs}`);
  };

  const client: TomTomClient = {
    id: "tomtom",

    async geocode(query) {
      const resp = await get<{ results?: { position: { lat: number; lon: number }; address?: { freeformAddress?: string } }[] }>(
        `/search/2/geocode/${encodeURIComponent(query)}.json`,
        { countrySet: "AM", lat: YEREVAN_CENTER[0], lon: YEREVAN_CENTER[1], limit: 1 },
      );
      const hit = resp.results?.[0];
      if (!hit) throw new ProviderError("tomtom", `could not geocode "${query}"`);
      return { label: hit.address?.freeformAddress ?? query, coord: [hit.position.lat, hit.position.lon] };
    },

    async route(req: RouteRequest) {
      const from = req.from.coord ? req.from : await client.geocode(req.from.address ?? req.from.label);
      const to = req.to.coord ? req.to : await client.geocode(req.to.address ?? req.to.label);
      const locs = [from.coord!, to.coord!].map(([la, lo]) => `${la},${lo}`).join(":");
      const resp = await get<TomTomRouteResponse>(`/routing/1/calculateRoute/${locs}/json`, {
        traffic: true,
        travelMode: "car",
        routeType: "fastest",
        maxAlternatives: req.alternatives,
        sectionType: ["traffic"],
        computeTravelTimeFor: "all",
        instructionsType: "text",
        language: tomtomLanguage(req.language),
        departAt: req.departAt ?? "now",
      });
      const routes = normalizeTomTom(resp, req.alternatives + 1);
      if (!routes.length) throw new ProviderError("tomtom", "no route found");
      return routes;
    },

    async flow(at) {
      const resp = await get<{
        flowSegmentData?: {
          frc?: string;
          currentSpeed: number;
          freeFlowSpeed: number;
          currentTravelTime: number;
          freeFlowTravelTime: number;
          confidence: number;
          roadClosure?: boolean;
          coordinates?: { coordinate?: { latitude: number; longitude: number }[] };
        };
      }>(`/traffic/services/4/flowSegmentData/absolute/10/json`, { point: `${at[0]},${at[1]}`, unit: "kmph" });
      const f = resp.flowSegmentData;
      if (!f) throw new ProviderError("tomtom", "no flow data for this point");
      const ratio = f.freeFlowSpeed ? f.currentSpeed / f.freeFlowSpeed : 1;
      return {
        road_class: f.frc,
        current_speed_kmh: f.currentSpeed,
        free_flow_speed_kmh: f.freeFlowSpeed,
        speed_ratio: round(ratio, 2),
        level: flowLevel(ratio, !!f.roadClosure),
        current_travel_time_s: f.currentTravelTime,
        free_flow_travel_time_s: f.freeFlowTravelTime,
        confidence: f.confidence,
        road_closed: !!f.roadClosure,
        geometry: (f.coordinates?.coordinate ?? []).map((c) => [c.latitude, c.longitude] as LatLon),
      };
    },

    async incidents(bbox, language) {
      const resp = await get<IncidentResponse>(`/traffic/services/5/incidentDetails`, {
        bbox: bbox.join(","),
        fields: INCIDENT_FIELDS,
        language: tomtomLanguage(language),
        timeValidityFilter: "present",
      });
      return normalizeIncidents(resp);
    },
  };
  return client;
}

function tomtomLanguage(lang: string): string {
  const map: Record<string, string> = { en: "en-GB", ru: "ru-RU", hy: "en-GB" };
  return map[lang] ?? lang;
}
