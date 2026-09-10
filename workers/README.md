# workers/api-proxy — Cloudflare Workers API proxy

Same-origin `/api/*` proxy for static hosting (Cloudflare Pages + Workers).
Zero dependencies, modules syntax (`export default { fetch }`). Upstream
targets mirror the Vite dev-server proxies in `vite.config.js`.

## Routes

| Route | Upstream |
|---|---|
| `/api/opensky*` | `https://opensky-network.org/api/*` (OAuth bearer when `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` set, else anonymous) |
| `/api/adsblol/*` | `https://api.adsb.lol/v2/*` (`/trace*` → `https://adsb.lol/data/traces/*`) |
| `/api/celestrak/*` | `https://celestrak.org/NORAD/elements/gp.php?GROUP=<g>&FORMAT=tle`, 6 h edge cache |
| `/api/launches*` | `https://ll.thespacedevs.com/2.3.0/launches/` (+ query passthrough) |
| `/api/cctv/*` | Catalog from `CCTV_SOURCES_JSON` env (JSON array) |
| `/api/ais-live` | Stateless status snapshot (no live socket in a Worker) |
| `/api/firms*` | `https://firms.modaps.eosdis.nasa.gov/...` (`/status` → mapkey status) |
| `/api/tomtom/*` | `https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf` |
| `/api/radio/*` | Radio Browser mirrors `de1/de2/nl1` with failover |
| `/api/gbfs/*` | Allowlisted GBFS providers only (`station_information`/`station_status`, https) |
| `/api/realtime/token` | `https://api.openai.com/v1/realtime/client_secrets` |
| `/api/realtime/debug-log` | Accepted + `console.log`ged (POST only, 204) |
| `/api/google/*` | Places `searchNearby` / `searchText` |
| `/api/overpass*` | Overpass mirrors (POST, failover) |
| `/api/military-installations*` | Bounded Overpass `military` query (`?bbox=w,s,e,n`, ≤10°) |

Errors are always JSON: `{ ok:false, error }`. CORS is permissive (`*`).
Secrets come ONLY from env bindings — never logged.

## Deploy

```bash
npx wrangler deploy workers/api-proxy.mjs --name gev-api
```

## Secrets (placeholder values only — never commit real keys)

```bash
wrangler secret put OPENSKY_CLIENT_ID      # e.g. your-opensky-client-id
wrangler secret put OPENSKY_CLIENT_SECRET  # e.g. your-opensky-client-secret
wrangler secret put AISSTREAM_API_KEY      # e.g. your-aisstream-key
wrangler secret put FIRMS_MAP_KEY          # e.g. your-firms-map-key
wrangler secret put TOMTOM_API_KEY         # e.g. your-tomtom-key
wrangler secret put LL2_API_TOKEN          # e.g. your-ll2-token (optional)
wrangler secret put OPENAI_API_KEY         # e.g. sk-your-openai-key
wrangler secret put GOOGLE_MAPS_API_KEY    # e.g. your-google-maps-key
wrangler secret put CCTV_SOURCES_JSON      # e.g. [{"id":"cam-1","lat":0,"lon":0,"imageUrl":"https://..."}]
```

Optional plain vars (wrangler.toml or dashboard):

```bash
# OPENAI_REALTIME_MODEL / OPENAI_REALTIME_MODEL_MINI / OPENAI_REALTIME_VOICE
```

## Notes / limits vs dev proxy

- No in-memory cross-request caching except the 6 h edge cache on TLE
  (`cf.cacheTtl`) and short `Cache-Control` headers elsewhere.
- `/api/ais-live` returns an empty stateless snapshot; for live vessels use a
  client-side AISStream socket or a Durable Object feed (future step).
- `/api/cctv` serves only the catalog list from `CCTV_SOURCES_JSON`; frame
  URLs proxy client-side.
- Do NOT deploy yet — step 1 is worker + README only, committed for review.
