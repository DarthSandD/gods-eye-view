# Omni Eyes CCTV — Findings

## Verified live (2026-09-11, segs advancing on re-check)
- JT toll (jmlive.jasamarga.com): KM 04+600, 10+600, 13+600, 15+500 (7 others 502 — dead cams)
- Serang-Panimbang (cctv.wikaserangpanimbang.com): Walantaka ON RAMP seq 19585→19779; all 13 infra 200
- JT infra FLAPS (04+600: 200→530→200). Serang solid. Worker degrades gracefully (no black loop).

## Architecture (why it was black)
- Worker had no CCTV_SOURCES_JSON → all /api/cctv/* 503
- Worker answered frame requests with JSON → broken images
- App used plain <video> with zero HLS support → m3u8 could never play
- Seeds have feedConfigured=false → steady placeholder (dark gradient reads as black blink)

## Fix (commit c73bab1 + 2283072)
- Worker: sources/health/stream/media/frame; playlist URIs rewritten to worker; SVG fallback (always 200 image)
- Catalog config/cctv_sources.indonesia.json: 2 live HLS + 6 placeholder+link
- App: hls.js attach for hls feeds, destroy on teardown; vendor/hls.min.js self-hosted
- Proxy proven: 282KB real MPEG-TS segment through worker (GStreamer bytes)

## Gotchas (do not repeat)
- terminal blocklist: keep inline commands small; use script files or execute_code
- search_files with empty params searches CWD noise — always pass full params
- gh-pages: dist is gitignored → deploy via omni-ghpages worktree (reset to origin tip on conflict)
- wrangler secret put needs piped stdin; deploys need --compatibility-date 2026-09-08
- curl -o /dev/null -w size can report 0 for live HLS — save body to verify bytes
- Upstream .ts returns 200-empty for expired sequences — always use a fresh playlist
