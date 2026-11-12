/**
 * Does each provider actually have live traffic in Yerevan?
 * Runs the same trips through every configured provider and prints ETA, traffic delay and
 * congested share side by side. Run at rush hour (08:30–10:00 or 18:00–20:00 local) and compare
 * with Yandex Navigator for the same trips.
 *
 *   GOOGLE_MAPS_API_KEY=... TOMTOM_API_KEY=... npm run coverage-check
 */
import { fmtDuration } from "../src/format.js";
import { parsePlace } from "../src/geo.js";
import { googleProvider } from "../src/providers/google.js";
import { tomtomProvider } from "../src/providers/tomtom.js";
import type { RouteProvider } from "../src/types.js";

const TRIPS: [string, string][] = [
  ["republic_square", "zvartnots_airport"],
  ["railway_station", "cascade"],
  ["opera", "republic_square"],
];

const providers: RouteProvider[] = [];
if (process.env.GOOGLE_MAPS_API_KEY) providers.push(googleProvider(process.env.GOOGLE_MAPS_API_KEY));
if (process.env.TOMTOM_API_KEY) providers.push(tomtomProvider(process.env.TOMTOM_API_KEY));
if (!providers.length) {
  console.error("Set GOOGLE_MAPS_API_KEY and/or TOMTOM_API_KEY.");
  process.exit(1);
}

console.log(`Yerevan traffic coverage check — ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Yerevan" })} Yerevan time\n`);
for (const [a, b] of TRIPS) {
  const from = parsePlace(a);
  const to = parsePlace(b);
  console.log(`${from.label} → ${to.label}`);
  for (const p of providers) {
    try {
      const [r] = await p.route({ from, to, alternatives: 0, language: "en" });
      const live = (r.traffic_delay_s ?? 0) > 0 || r.load.congested_share > 0;
      console.log(
        `  ${p.id.padEnd(7)} ETA ${fmtDuration(r.duration_s).padEnd(9)} empty-road ${fmtDuration(r.no_traffic_duration_s).padEnd(9)} ` +
          `delay ${fmtDuration(r.traffic_delay_s).padEnd(7)} congested ${(r.load.congested_share * 100).toFixed(0).padStart(3)}%  ` +
          `jam ${r.load.jam_m} m  slow ${r.load.slow_m} m  no-data ${r.load.unknown_m} m  ${live ? "LIVE SIGNAL" : "no live signal"}`,
      );
    } catch (e) {
      console.log(`  ${p.id.padEnd(7)} ERROR ${(e as Error).message}`);
    }
  }
  console.log();
}
