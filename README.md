# VisualForge AI — Diferia & QC Inspection Trainer

**One verified visual-difference engine, three experiences.** Given any image, VisualForge produces a modified version with realistic, localized, *verified* changes — plus the exact bounding box and mask of each change.

Built by **Damian Sinay** (indie developer) for the **Meta Global AI Developer Hackathon 2026**, Indie Developer track, theme *"Build for Your World"*. **Deadline: Wed Nov 4, 9:00 PM ET.** Live demo URL: *(placeholder — after Vercel deploy approval)*

## The three experiences
1. **🔎 Diferia: Play Your Photo** — upload your photo or describe a theme → the engine forges N differences → play in the browser (timer, limited mistakes, hints, score, shareable link; clicks validated server-side, annotations never leak early).
2. **🏁 Diferia Online** — real-time race for 2–4 players: rooms with codes, lobby/Presence, synchronized countdown, first-finder-claims-it (DB unique constraint), live scoreboard, best of 3 + rematch.
3. **🏭 QC Inspection Trainer** — the same engine generates realistic product defects (scratch, crack, dent, missing component…) to train inspectors and export labeled **COCO JSON / YOLO** datasets. *Synthetic — validate before industrial use.*

## How Meta models are used
```text
upload/theme → Muse Spark moderation → SAM 3.1 segmentation → Muse Spark plan (JSON, non-overlapping)
→ Muse Image edit (masked region only) → composite (outside mask = pixel-identical)
→ measure REAL pixel diff → real mask/bbox → Muse Spark verify (retry once, else needs_review) → publish
```
Full detail, prompts, verified endpoints and costs: [AI_INTEGRATION.md](AI_INTEGRATION.md). **The real Meta providers (SAM 3.1 streaming segmentation, Muse Spark structured plan/verify, Muse Image edit) are implemented verbatim from the official docs; the Phase-0 spike (max 6 paid calls) runs only after tests pass and phases are committed — no paid calls have been made yet.** Until then the app runs a clearly-labeled **MOCK** provider (UI banner + output labels); the real provider refuses loudly rather than falling back silently.

## Setup
```bash
npm install && cp .env.example .env.local   # fill Supabase + Meta (server-only) keys
npm run dev                            # http://localhost:3000
```
Supabase: apply [supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql) (14 tables, RLS: clients can't read `differences` of unfinished levels, `round_finds` race constraint, 24h upload expiry). Python worker: `worker/composite.py` (Pillow/NumPy — Vercel Python Function if it fits limits, else we stop and propose Modal).

## Tests
```bash
npm test            # Vitest: pipeline, composite invariant, mask→bbox, click tolerance, scoring, race, COCO/YOLO, provider, limits
.venv/bin/python -m pytest tests/test_composite.py   # Python env lives in .venv (git-ignored)
npm run test:e2e    # Playwright: single-player flow on MOCK
```
**Status (2026-10-28): all green** — Vitest 16/16, pytest 2/2, Playwright 1/1, run locally after the Phase-0 doc verification.

## Feature status
| Feature | Status |
|---|---|
| Engine pipeline + providers + credit limits | ✅ code (mock-verified logic) · ⏳ real Meta (Phase 0) |
| Play Your Photo (offline MOCK level, server-validated clicks) | ✅ playable slice · ⏳ upload/theme with real models |
| Diferia Online (room/race/best-of-3 UI + DB race guard) | 🟡 local simulation · ⏳ Supabase Realtime wiring |
| QC Trainer + COCO/YOLO export | ✅ playable slice · ⏳ batch dataset review flow |
| Landing "one engine, three uses" | ✅ |

## Built during the hackathon
Everything in this repository: Next.js app, engine, providers, Supabase schema, Python worker, tests, docs — written from scratch during the event. No pre-existing code imported, no third-party images (scenes are procedural/MOCK or Muse Image-generated).

## Built with Muse
This project was built with **Muse** (Anthropic's CLI) as the development partner.

## Known limitations
Real Meta integration awaits the Phase-0 spike; Supabase Realtime multiplayer and storage uploads need project credentials; demo scenes are procedural shapes, not photos, until Muse Image is verified.

MIT License — see [LICENSE](LICENSE).
