/** A WGS84 coordinate as [latitude, longitude]. */
export type LatLon = [number, number];

export type ProviderId = "google" | "tomtom";

/**
 * Congestion level of a stretch of road, roughly the colours of a navigator's route line:
 * free = green, slow = yellow, jam = red, closed = black. `unknown` = provider gave no reading.
 */
export type Level = "free" | "slow" | "jam" | "closed" | "unknown";

/** A resolved place: either parsed from "lat,lon", a built-in Yerevan landmark, or geocoded. */
export interface Place {
  label: string;
  coord?: LatLon;
  /** Free-text address to hand to a provider that geocodes itself (Google). */
  address?: string;
}

export interface Segment {
  level: Level;
  /** What causes the slowdown, when the provider says (TomTom only). */
  cause?: "jam" | "roadworks" | "closure" | "other";
  length_m: number;
  /** Street the segment starts on, taken from the turn-by-turn instructions. */
  road?: string;
  /** Measured speed through the segment (TomTom only). */
  speed_kmh?: number;
  /** Extra seconds this segment costs compared to free flow (TomTom only). */
  delay_s?: number;
  start: LatLon;
  end: LatLon;
  /** Index range into the route polyline, [from, to). */
  from_index: number;
  to_index: number;
}

export interface LoadSummary {
  free_m: number;
  slow_m: number;
  jam_m: number;
  closed_m: number;
  unknown_m: number;
  /** Share of the route length that is slow, jammed or closed (0..1). */
  congested_share: number;
}

export interface Step {
  instruction: string;
  distance_m?: number;
}

export interface Route {
  provider: ProviderId;
  /** 0 = provider's primary route. */
  index: number;
  label?: string;
  /** Short "via" text: Google's route description or the longest streets on the TomTom route. */
  via?: string;
  duration_s: number;
  /** Travel time on empty roads, if the provider reports it. */
  no_traffic_duration_s?: number;
  traffic_delay_s?: number;
  distance_m: number;
  load: LoadSummary;
  segments: Segment[];
  steps: Step[];
  geometry: LatLon[];
}

export interface RouteRequest {
  from: Place;
  to: Place;
  /** Number of alternative routes to ask for besides the main one (0..3). */
  alternatives: number;
  /** ISO 8601 departure time; omitted = now. */
  departAt?: string;
  language: string;
}

export interface RouteProvider {
  id: ProviderId;
  route(req: RouteRequest): Promise<Route[]>;
}

export type FetchLike = typeof fetch;
