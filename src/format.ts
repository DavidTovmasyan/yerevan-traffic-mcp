import type { Route, Segment } from "./types.js";

export function fmtDuration(s: number | undefined): string {
  if (s === undefined) return "?";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

const LEVEL_WORD: Record<Segment["level"], string> = {
  free: "free-flowing",
  slow: "slow",
  jam: "jammed",
  closed: "closed",
  unknown: "no data",
};

/** One line per route, navigator style. */
export function routeHeadline(r: Route): string {
  const parts = [
    `${r.provider} #${r.index}${r.label ? ` (${r.label})` : ""}: ${fmtDuration(r.duration_s)}, ${fmtDistance(r.distance_m)}`,
  ];
  if (r.traffic_delay_s) parts.push(`+${fmtDuration(r.traffic_delay_s)} from traffic`);
  parts.push(`${Math.round(r.load.congested_share * 100)}% congested`);
  if (r.via) parts.push(r.via);
  return parts.join(" · ");
}

/** Plain-language list of the congested stretches, worst first. */
export function hotspots(r: Route, limit = 5): string[] {
  const rank = { closed: 3, jam: 2, slow: 1, free: 0, unknown: 0 } as const;
  return r.segments
    .filter((s) => rank[s.level] > 0)
    .sort((a, b) => rank[b.level] - rank[a.level] || b.length_m - a.length_m)
    .slice(0, limit)
    .map((s) => {
      const extra = [s.speed_kmh !== undefined ? `${s.speed_kmh} km/h` : "", s.delay_s ? `+${fmtDuration(s.delay_s)}` : ""]
        .filter(Boolean)
        .join(", ");
      return `${LEVEL_WORD[s.level]} ${fmtDistance(s.length_m)}${s.road ? ` on ${s.road}` : ""}${extra ? ` (${extra})` : ""}`;
    });
}

export type SegmentMode = "congested" | "all" | "none";

export interface RouteView {
  headline: string;
  hotspots: string[];
  route: Omit<Route, "geometry" | "steps" | "segments"> & {
    segments?: Segment[];
    steps?: Route["steps"];
    geometry?: Route["geometry"];
  };
}

export function viewRoute(r: Route, opts: { segments: SegmentMode; steps: boolean; geometry: boolean }): RouteView {
  const { geometry, steps, segments, ...rest } = r;
  const route: RouteView["route"] = { ...rest };
  if (opts.segments === "all") route.segments = segments;
  else if (opts.segments === "congested") route.segments = segments.filter((s) => s.level !== "free" && s.level !== "unknown");
  if (opts.steps) route.steps = steps;
  if (opts.geometry) route.geometry = geometry;
  return { headline: routeHeadline(r), hotspots: hotspots(r), route };
}

/** Pick the route a navigator would suggest: fastest with live traffic. */
export function recommend(routes: Route[]): Route | undefined {
  return [...routes].sort((a, b) => a.duration_s - b.duration_s)[0];
}
