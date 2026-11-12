/**
 * Google Routes API v2 (computeRoutes) with TRAFFIC_ON_POLYLINE.
 * Docs: https://developers.google.com/maps/documentation/routes/traffic_on_polylines
 */
import { buildSegments, decodePolyline, nearestIndex, summarizeLoad, type RawInterval } from "../geo.js";
import { fetchJson, ProviderError } from "../http.js";
import type { FetchLike, LatLon, Level, Place, Route, RouteProvider, RouteRequest, Step } from "../types.js";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

const FIELD_MASK = [
  "routes.duration",
  "routes.staticDuration",
  "routes.distanceMeters",
  "routes.description",
  "routes.routeLabels",
  "routes.warnings",
  "routes.polyline.encodedPolyline",
  "routes.travelAdvisory.speedReadingIntervals",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.startLocation",
  "routes.legs.steps.navigationInstruction",
].join(",");

export interface GoogleSpeedInterval {
  startPolylinePointIndex?: number;
  endPolylinePointIndex?: number;
  speed?: string;
}

export interface GoogleRoute {
  duration?: string;
  staticDuration?: string;
  distanceMeters?: number;
  description?: string;
  routeLabels?: string[];
  warnings?: string[];
  polyline?: { encodedPolyline?: string };
  travelAdvisory?: { speedReadingIntervals?: GoogleSpeedInterval[] };
  legs?: {
    steps?: {
      distanceMeters?: number;
      startLocation?: { latLng?: { latitude: number; longitude: number } };
      navigationInstruction?: { maneuver?: string; instructions?: string };
    }[];
  }[];
}

export interface GoogleResponse {
  routes?: GoogleRoute[];
}

const SPEED_TO_LEVEL: Record<string, Level> = { NORMAL: "free", SLOW: "slow", TRAFFIC_JAM: "jam" };

export function parseDuration(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const n = parseFloat(d.replace(/s$/, ""));
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

function waypoint(p: Place) {
  if (p.coord) return { location: { latLng: { latitude: p.coord[0], longitude: p.coord[1] } } };
  return { address: p.address ?? p.label };
}

/** Pull the street name out of "Turn left onto Mashtots Ave\nPass by ..." style text. */
export function streetFromInstruction(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const first = text.split("\n")[0].trim();
  const m = /\b(?:onto|on|toward|towards|via)\s+(.+)$/i.exec(first);
  return (m ? m[1] : first).trim() || undefined;
}

export function buildGoogleBody(req: RouteRequest) {
  const alternatives = req.alternatives > 0;
  const body: Record<string, unknown> = {
    origin: waypoint(req.from),
    destination: waypoint(req.to),
    travelMode: "DRIVE",
    // Google documents alternatives together with TRAFFIC_AWARE; TRAFFIC_AWARE_OPTIMAL is the
    // more accurate model, so use it whenever only one route is wanted.
    routingPreference: alternatives ? "TRAFFIC_AWARE" : "TRAFFIC_AWARE_OPTIMAL",
    computeAlternativeRoutes: alternatives,
    extraComputations: ["TRAFFIC_ON_POLYLINE"],
    polylineQuality: "HIGH_QUALITY",
    languageCode: req.language,
    regionCode: "am",
    units: "METRIC",
  };
  if (req.departAt) {
    const t = new Date(req.departAt);
    if (Number.isNaN(t.getTime())) throw new ProviderError("google", `invalid depart_at: ${req.departAt}`);
    // Google rejects past departure times for DRIVE; treat "a moment ago" as now.
    if (t.getTime() > Date.now() + 60_000) body.departureTime = t.toISOString();
  }
  return body;
}

export function normalizeGoogle(resp: GoogleResponse, maxRoutes: number): Route[] {
  return (resp.routes ?? []).slice(0, maxRoutes).map((r, index) => {
    const points = decodePolyline(r.polyline?.encodedPolyline ?? "");

    // Map each turn-by-turn step to where it starts on the route polyline, so every segment
    // can be named after the street it is on.
    const steps: Step[] = [];
    const stepStarts: { index: number; road?: string }[] = [];
    let cursor = 0;
    for (const leg of r.legs ?? []) {
      for (const st of leg.steps ?? []) {
        const text = st.navigationInstruction?.instructions;
        if (text) steps.push({ instruction: text.replace(/\n/g, " — "), distance_m: st.distanceMeters });
        const ll = st.startLocation?.latLng;
        if (ll && points.length) {
          cursor = nearestIndex(points, [ll.latitude, ll.longitude] as LatLon, cursor);
          stepStarts.push({ index: cursor, road: streetFromInstruction(text) });
        }
      }
    }
    const roadAt = (i: number) => {
      let road: string | undefined;
      for (const s of stepStarts) if (s.index <= i) road = s.road ?? road;
      return road;
    };

    const intervals: RawInterval[] = (r.travelAdvisory?.speedReadingIntervals ?? []).map((iv) => ({
      from: iv.startPolylinePointIndex ?? 0, // proto3 omits zero
      to: iv.endPolylinePointIndex ?? 0,
      level: SPEED_TO_LEVEL[iv.speed ?? ""] ?? "unknown",
    }));
    const segments = buildSegments(points, intervals, "unknown", roadAt);

    const duration = parseDuration(r.duration) ?? 0;
    const staticDuration = parseDuration(r.staticDuration);
    const route: Route = {
      provider: "google",
      index,
      label: r.routeLabels?.includes("DEFAULT_ROUTE") ? "default" : r.routeLabels?.length ? "alternative" : undefined,
      via: r.description || undefined,
      duration_s: duration,
      no_traffic_duration_s: staticDuration,
      traffic_delay_s: staticDuration !== undefined ? Math.max(0, duration - staticDuration) : undefined,
      distance_m: r.distanceMeters ?? 0,
      load: summarizeLoad(segments),
      segments,
      steps,
      geometry: points,
    };
    return route;
  });
}

export function googleProvider(apiKey: string, fetchImpl: FetchLike = fetch): RouteProvider {
  return {
    id: "google",
    async route(req) {
      const resp = await fetchJson<GoogleResponse>("google", fetchImpl, ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(buildGoogleBody(req)),
      });
      const routes = normalizeGoogle(resp, req.alternatives + 1);
      if (!routes.length) throw new ProviderError("google", "no route found");
      return routes;
    },
  };
}
