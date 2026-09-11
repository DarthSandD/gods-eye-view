# Omni Eyes CCTV — Progress

## 2026-09-11
- Recon: JT page (11 named streams) + Serang page (13 cams, own host) parsed; liveness swept
- Worker CCTV sub-router + playlist rewrite written, syntax OK
- Catalog (8 ID cameras) set as CCTV_SOURCES_JSON secret; worker deployed (e1b054ba)
- Endpoints verified: sources/health/media(rewrite)/frame(SVG) all 200
- App HLS wiring (CDN → self-hosted vendor/hls.min.js); 123/123 CCTV tests, full suite green
- Built (bundle XuZKCmJK) + deployed omnieyes.pages.dev + github.io/omni-eyes-view (e1dfe1d, 5e3d3c9)
- Both domains verified serving new bundle + vendor/hls.min.js 200
- Tri reports black blink on phone → diagnosed: cached old bundle (no HLS code) + dark placeholder
- YouTube skill learned (Planning with Files, Delegate, RTK, Mantis, Agent Reach, retriever)

## Next
- Tri phone proof (private tab → Serang → Walantaka, 5s buffer)
- If still black: screenshot + camera name → fix from evidence
- Bonus: Bandung/Semarang/Surabaya direct-stream extraction
