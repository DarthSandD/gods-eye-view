# Omni Eyes CCTV — Task Plan

Goal: CCTV shows live Indonesian footage inside the globe on both public sites.
Done = fresh phone load plays Walantaka footage on the monitor plane.

## Phases
- [x] Recon: extract + verify upstream streams (JT 4/11 live, Serang 13/13 infra live)
- [x] Worker: sub-routes (sources/health/stream/media/frame) + playlist rewrite + ID catalog
- [x] App: hls.js playback wiring (self-hosted vendor/hls.min.js)
- [x] Deploy: worker + both domains, bundles verified
- [x] Tests: 123/123 CCTV + full suite green
- [ ] Phone proof: Tri fresh-loads (private tab) → Serang → Walantaka plays
- [ ] Bonus: direct streams for Bandung/Semarang/Surabaya (currently placeholders + links)

## Decisions
- Browser-native HLS via hls.js, zero backend voice/video cost (Tri: free only)
- Worker proxies playlists + segments (CORS solved server-side)
- Placeholder + WATCH LIVE links where no direct stream verified (never fake footage)
- Unified rule: identical dist on omnieyes.pages.dev + github.io/omni-eyes-view
