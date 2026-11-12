import type { LatLon, Level, LoadSummary, Place, Segment } from "./types.js";

/** Decode a Google encoded polyline (precision 5). */
export function decodePolyline(encoded: string): LatLon[] {
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

/** Encode coordinates as a Google polyline (precision 5). Used by tests and fixtures. */
export function encodePolyline(points: LatLon[]): string {
  let out = "";
  let prevLat = 0;
  let prevLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [la, lo] of points) {
    const lat = Math.round(la * 1e5);
    const lon = Math.round(lo * 1e5);
    out += enc(lat - prevLat) + enc(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}

export function haversine(a: LatLon, b: LatLon): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Length in metres of the polyline between point indices [from, to] (inclusive of both points). */
export function pathLength(points: LatLon[], from: number, to: number): number {
  let d = 0;
  for (let i = Math.max(from, 0); i < Math.min(to, points.length - 1); i++) d += haversine(points[i], points[i + 1]);
  return d;
}

/** Index of the polyline point nearest to `p`, searching from `startAt` onwards. */
export function nearestIndex(points: LatLon[], p: LatLon, startAt = 0): number {
  let best = startAt;
  let bestD = Infinity;
  for (let i = startAt; i < points.length; i++) {
    const d = haversine(points[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** A raw provider reading over a polyline index range, before gap filling. */
export interface RawInterval {
  from: number;
  to: number;
  level: Level;
  cause?: Segment["cause"];
  speed_kmh?: number;
  delay_s?: number;
}

/**
 * Turn provider intervals into a full, ordered cover of the polyline: gaps are filled with
 * `gapLevel`, and neighbouring stretches at the same level (and no extra data) are merged.
 * `roadAt(i)` names the street at polyline point i.
 */
export function buildSegments(
  points: LatLon[],
  intervals: RawInterval[],
  gapLevel: Level,
  roadAt: (i: number) => string | undefined,
): Segment[] {
  const last = points.length - 1;
  if (last < 1) return [];
  const sorted = intervals
    .map((iv) => ({ ...iv, from: clamp(iv.from, 0, last), to: clamp(iv.to, 0, last) }))
    .filter((iv) => iv.to > iv.from)
    .sort((a, b) => a.from - b.from);

  const raw: RawInterval[] = [];
  let cursor = 0;
  for (const iv of sorted) {
    const from = Math.max(iv.from, cursor);
    if (from >= iv.to) continue;
    if (from > cursor) raw.push({ from: cursor, to: from, level: gapLevel });
    raw.push({ ...iv, from });
    cursor = iv.to;
  }
  if (cursor < last) raw.push({ from: cursor, to: last, level: gapLevel });

  const merged: RawInterval[] = [];
  for (const iv of raw) {
    const prev = merged[merged.length - 1];
    const plain = (x: RawInterval) => x.speed_kmh === undefined && x.delay_s === undefined && x.cause === undefined;
    if (prev && prev.level === iv.level && prev.to === iv.from && plain(prev) && plain(iv)) prev.to = iv.to;
    else merged.push({ ...iv });
  }

  return merged.map((iv) => {
    const seg: Segment = {
      level: iv.level,
      length_m: Math.round(pathLength(points, iv.from, iv.to)),
      start: points[iv.from],
      end: points[iv.to],
      from_index: iv.from,
      to_index: iv.to,
    };
    const road = roadAt(iv.from);
    if (road) seg.road = road;
    if (iv.cause) seg.cause = iv.cause;
    if (iv.speed_kmh !== undefined) seg.speed_kmh = iv.speed_kmh;
    if (iv.delay_s !== undefined) seg.delay_s = iv.delay_s;
    return seg;
  });
}

export function summarizeLoad(segments: Segment[]): LoadSummary {
  const s: LoadSummary = { free_m: 0, slow_m: 0, jam_m: 0, closed_m: 0, unknown_m: 0, congested_share: 0 };
  for (const seg of segments) s[`${seg.level}_m` as const] += seg.length_m;
  const total = s.free_m + s.slow_m + s.jam_m + s.closed_m + s.unknown_m;
  s.congested_share = total ? round((s.slow_m + s.jam_m + s.closed_m) / total, 3) : 0;
  return s;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

export function round(v: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Built-in Yerevan landmarks so "Republic Square" works without a geocoder.
 * Coordinates are approximate (to ~100 m), good enough as route endpoints.
 */
export const YEREVAN_PLACES: Record<string, { label: string; coord: LatLon; aliases: string[] }> = {
  republic_square: { label: "Republic Square", coord: [40.1777, 44.5126], aliases: ["republic square", "hraparak", "հանրապետության հրապարակ"] },
  zvartnots_airport: { label: "Zvartnots International Airport", coord: [40.1473, 44.3959], aliases: ["zvartnots", "airport", "evn", "zvartnots airport", "զվարթնոց"] },
  cascade: { label: "Cascade Complex", coord: [40.1913, 44.5155], aliases: ["cascade", "kaskad", "կասկադ"] },
  opera: { label: "Opera and Ballet Theatre", coord: [40.1863, 44.5152], aliases: ["opera", "opera theatre", "օպերա"] },
  railway_station: { label: "Yerevan Railway Station (Sasuntsi David)", coord: [40.1561, 44.5091], aliases: ["railway station", "train station", "sasuntsi david", "կայարան"] },
};

/** Yerevan bounding box as [minLon, minLat, maxLon, maxLat]. */
export const YEREVAN_BBOX: [number, number, number, number] = [44.36, 40.06, 44.62, 40.25];
export const YEREVAN_CENTER: LatLon = [40.1792, 44.4991];

const LATLON_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Parse a user-supplied location: "40.1777,44.5126", a built-in landmark name/key, or free text
 * (returned as an address for the provider to geocode).
 */
export function parsePlace(input: string): Place {
  const m = LATLON_RE.exec(input);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Accept lon,lat too: in Yerevan latitude ~40 and longitude ~44.
    const coord: LatLon = a > 42 && b < 42 ? [b, a] : [a, b];
    if (Math.abs(coord[0]) > 90 || Math.abs(coord[1]) > 180) throw new Error(`Not a valid coordinate: "${input}"`);
    return { label: `${coord[0]},${coord[1]}`, coord };
  }
  const key = input.trim().toLowerCase();
  for (const [id, p] of Object.entries(YEREVAN_PLACES)) {
    if (id === key.replace(/\s+/g, "_") || p.aliases.includes(key)) return { label: p.label, coord: p.coord };
  }
  if (!key) throw new Error("Empty location");
  return { label: input.trim(), address: input.trim() };
}
