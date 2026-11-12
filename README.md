# yerevan-traffic-mcp

An MCP server that gives an AI assistant **navigator-style driving routes for Yerevan with live traffic**:
ETA, the delay caused by traffic, up to 3 alternative routes, and congestion per stretch of road
(free / slow / jam / closed) with street names. That's the coloured route line Yandex Navigator shows,
returned as JSON.

It wraps two licensed traffic APIs:

| Provider | Used for | What it returns per stretch |
|---|---|---|
| **Google Routes API** (`computeRoutes` + `TRAFFIC_ON_POLYLINE`) | `get_route`, `compare_providers` | `NORMAL` / `SLOW` / `TRAFFIC_JAM` for every polyline interval |
| **TomTom** Routing (`sectionType=traffic`), Traffic Flow, Traffic Incidents v5, Search | `get_route`, `compare_providers`, `get_road_speed`, `get_traffic_incidents` | Congested sections with category (jam / road works / closure), speed in km/h and delay in seconds |

Set either key, or both. Nothing here scrapes Yandex.

> **TomTom has no live traffic for Yerevan** (tested 2026-11-12, Thursday 16:52 local): Traffic Flow
> returns "Point too far from nearest existing segment" everywhere in the city including Republic
> Square, Incidents returns 0 for the whole city, and routes come back with `trafficDelayInSeconds: 0`.
> TomTom routing itself works (streets, turn-by-turn, alternatives), and its geocoder does not find most
> Yerevan addresses, so pass coordinates. Google is the remaining candidate for live traffic.
>
> **Google coverage is not yet verified.** Neither Google nor TomTom documents live traffic coverage for
> Armenia. Before relying on a provider, run `npm run coverage-check` at rush hour and compare with
> Yandex Navigator (see [Verifying coverage](#verifying-coverage)).

## Tools

| Tool | What it answers |
|---|---|
| `get_route` | Route A → B: ETA, empty-road time, traffic delay, alternatives, congested stretches with street names, recommended (fastest) route. Optional turn-by-turn steps and full geometry. |
| `compare_providers` | Same trip through every configured provider, side by side, with a `live_traffic_signal` flag. |
| `get_road_speed` | Current vs free-flow speed on the road at a point ("is Mashtots jammed right now?"). TomTom. |
| `get_traffic_incidents` | Accidents, jams, road works and closures in Yerevan or within a radius of a point. TomTom. |
| `traffic_status` | Which providers are configured; built-in landmarks. |

Locations can be:
- `"lat,lon"` such as `"40.1777,44.5126"` (`lon,lat` is detected and swapped)
- a built-in landmark: `republic_square`, `zvartnots_airport`, `cascade`, `opera`, `railway_station`
- a free-text address. Google geocodes it within the route request; TomTom geocodes it via Search, biased to Armenia.

### Example `get_route` output (abridged; illustrative values)

```json
{
  "provider": "google",
  "from": "Republic Square",
  "to": "Zvartnots International Airport",
  "recommended": { "index": 0, "why": "fastest with current traffic, 4 min quicker than the next option" },
  "routes": [
    {
      "headline": "google #0 (default): 24 min, 13.1 km · +7 min from traffic · 31% congested · via Tigran Mets Ave",
      "hotspots": ["jammed 1.2 km on Tigran Mets Ave", "slow 800 m on Admiral Isakov Ave"],
      "route": {
        "duration_s": 1440, "no_traffic_duration_s": 1020, "traffic_delay_s": 420, "distance_m": 13100,
        "load": { "free_m": 9000, "slow_m": 2900, "jam_m": 1200, "closed_m": 0, "unknown_m": 0, "congested_share": 0.313 },
        "segments": [
          { "level": "jam", "length_m": 1200, "road": "Tigran Mets Ave", "start": [40.17, 44.51], "end": [40.16, 44.51], "from_index": 41, "to_index": 77 }
        ]
      }
    }
  ]
}
```

## Setup

Requires Node.js 20 or newer.

```bash
git clone https://github.com/DavidTovmasyan/yerevan-traffic-mcp.git
cd yerevan-traffic-mcp
npm install          # also builds dist/
```

### API keys

- **Google:** in a Google Cloud project, enable the **Routes API** and create an API key. Restrict the key to that API.
  Billing must be enabled. Traffic-aware requests with traffic-on-polyline are billed at the Routes "Advanced/Pro" tier.
- **TomTom:** create a key at <https://developer.tomtom.com>. The free tier includes Routing, Traffic and Search.

### Register with Claude Code

```bash
claude mcp add yerevan-traffic \
  -e GOOGLE_MAPS_API_KEY=... \
  -e TOMTOM_API_KEY=... \
  -- node "$PWD/dist/index.js"
```

For a JSON-config client (Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "yerevan-traffic": {
      "command": "node",
      "args": ["/absolute/path/to/yerevan-traffic-mcp/dist/index.js"],
      "env": { "GOOGLE_MAPS_API_KEY": "...", "TOMTOM_API_KEY": "..." }
    }
  }
}
```

Restart the client, then ask: *"How long from Republic Square to Zvartnots right now, and where are the jams?"*

## Verifying coverage

```bash
GOOGLE_MAPS_API_KEY=... TOMTOM_API_KEY=... npm run coverage-check
```

This prints ETA, empty-road time, delay and congested share for a few fixed Yerevan trips, for each
provider. Run it on a weekday at 08:30–10:00 or 18:00–20:00, and open the same trips in Yandex
Navigator. Interpret the results this way:

- **Zero delay and 0% congested at rush hour** means the provider has no live data for Yerevan. It is falling back to free-flow or historical speeds.
- **Google `unknown_m` covering most of the route** means Google returned no speed readings for those stretches.
- An ETA close to Navigator's, with jams on the same streets, means the provider is usable.

## How it works

```
from/to ─► parsePlace ─► provider.route()
                           │
     Google: decode polyline, speedReadingIntervals ─┐
     TomTom: legs[].points, sections[TRAFFIC]  ──────┤
                                                     ▼
                         buildSegments(): fill gaps, merge same-level neighbours,
                         name each stretch from turn-by-turn steps, measure length
                                                     ▼
                         summarizeLoad() ─► Route { ETA, delay, load, segments }
                                                     ▼
                         viewRoute(): headline, hotspots, filtered segments
```

Details:
- **Google:** `routingPreference` is `TRAFFIC_AWARE_OPTIMAL` for a single route and `TRAFFIC_AWARE` when alternatives are requested. Google documents alternatives only with `TRAFFIC_AWARE`. Stretches without a speed reading are `unknown`, not `free`.
- **TomTom:** only congested stretches come back as `TRAFFIC` sections, so everything else is `free`. Level comes from `simpleCategory` plus `magnitudeOfDelay`: closure → `closed`, major → `jam`, otherwise `slow`.
- **Departure time:** `depart_at` gives a predicted ETA. Google rejects past times for driving, so the server sends "now" for those.
- **Key safety:** API keys are redacted from any error text returned to the model.

## Development

```bash
npm run dev         # run from source (tsx)
npm run typecheck
npm test            # vitest; fixtures only, no network
```

Layout:
- `src/server.ts`: tool definitions
- `src/providers/google.ts`, `src/providers/tomtom.ts`: API clients and normalisation
- `src/geo.ts`: polyline, segment building, places
- `src/format.ts`: headlines and hotspots

## Limitations

- Driving only, no public transit.
- No Yandex data. Yandex's Router API is paid, has no documented per-segment jams and doesn't list Armenia in its coverage. Per-segment jams are only in the mobile MapKit SDK.
- Landmark coordinates are approximate, to about 100 m.
- TomTom point indices are assumed route-global across legs. That is fine for A → B; check before adding waypoints.
