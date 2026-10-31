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
Full detail, prompts, verified endpoints and costs: [AI_INTEGRATION.md](AI_INTEGRATION.md). **The real Meta providers (SAM 3.1 streaming segmentation, Muse Spark structured plan/verify, Muse Image crop-edit + composite) are implemented verbatim from the official docs and were validated end-to-end by the Phase-0 spike on 2026-10-29 (5 paid calls, full loop verified; full-image editing rejected with pixel evidence). They are wired into the app as async generation jobs (`POST /api/generate` → poll → playable level) behind the kill switch and credit limits.** With the offline **MOCK** provider (clearly labeled in the UI and outputs) the app returns the demo level instead — never a silent fake.

## Setup
```bash
npm install && cp .env.example .env.local   # fill Supabase + Meta (server-only) keys
npm run dev                            # http://localhost:3000
```
Supabase: apply [supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql) (14 tables, RLS: clients can't read `differences` of unfinished levels, `round_finds` race constraint, 24h upload expiry). Python worker: `worker/composite.py` (Pillow/NumPy — Vercel Python Function if it fits limits, else we stop and propose Modal).

## Configuration (server-side, `.env.local`)
The Play page is intentionally user-facing — none of this appears in the UI. Real Meta generation is opt-in and credit-protected:
- `AI_PROVIDER=meta` + `META_REAL_CALLS_ENABLED=true` + `MODEL_API_KEY`: enables real generation. Without them, `/play` returns a clearly labeled demo level (offline MOCK provider) — never a silent fake "AI" result.
- `VF_THEME_GENERATION=true`: enables theme→scene generation on `/play`. Flow: Muse Spark **text-only moderation first** (a rejected theme never reaches a paid call and fails as `theme_rejected`), then one Muse Image generation (`POST /v1/images/generations`, docs-verified shape: aspect-only `size`, no `moderation` field — that enum is Spark-only; flat $0.01/image, logged per call in `visualforge_ai_calls`), then the standard pipeline. The theme and the model's `revised_prompt` are stored on the level (migration `0003_level_theme.sql`; pre-0003 databases simply persist without them).
- `VF_SCENE_REASONING` (`low|medium|high`, default `high`): reasoning effort for the scene-generation call only.
- `VF_SAM_MASKS=true`: use real SAM masks (official `@meta-sam/parser`) for local recolor/compositing, with per-change fallback to bbox behavior.
- Hints & per-difference difficulty (capability 2, always on with the real provider): the level **publishes the moment its differences are measured**; afterwards, **one** Muse Spark call per level runs **in the background** and writes 3 progressive hints and a difficulty rating (1–5) per difference (migration `0004_difference_hints.sql`; pre-0004 databases persist without them). `POST /api/hint` serves the next hint of the easiest pending difference — until the Spark hints land it serves a positional hint derived from the bbox, marked `provisional` (Play labels it "Quick hint"); the score weights each find by its difficulty. One-pass component selection applies a visibility floor by job difficulty as a **priority, not a gate** (easy: area ≥ 0.25 % of the image and mean amplitude ≥ 40; medium: ≥ 0.12 % / ≥ 35; hard: no floor): above-floor components go first, below-floor ones only fill the count, logged as such.
- Count guarantee (game mode): a level **never ships short**. Order of remedies: one-pass → crop candidates → **replacement plan** (one extra Spark call for the missing count + 2, planned over only the regions that don't overlap an accepted difference) → one completion full-image Muse call asking only for the missing differences. Still short, the job fails with a clear message ("We could only create X of the N differences…") instead of delivering a short level.
- Credit guards: `MAX_CHANGES_PER_JOB`, `MAX_JOBS_PER_DAY`, `ESTIMATED_COST_PER_LEVEL_USD` (see [src/lib/limits.ts](src/lib/limits.ts)).
- Supabase persistence is best-effort and additive: jobs/levels/differences/images/ai-calls are mirrored to `visualforge_*` tables when `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set; the game also works fully in-memory without them.

## Tests
```bash
npm test            # Vitest: pipeline, composite invariant, mask→bbox, click tolerance, scoring, race, COCO/YOLO, provider, limits
.venv/bin/python -m pytest tests/test_composite.py   # Python env lives in .venv (git-ignored)
npm run test:e2e    # Playwright: single-player flow on MOCK
```
**Status (2026-10-31):** Vitest 75/75 (incl. the async generation loop with fake providers, the one-pass path, duplicate-difference dedupe, the visibility floor as priority with below-floor fillers, Spark hints + difficulty written in the background after publication, the count-completion guarantee — replacement plan over free regions, then a completion one-pass call, otherwise the job fails loudly — theme generation, and sharp composite/measurement invariants) and Playwright 1/1 verified 2026-10-30; pytest 2/2 last verified 2026-10-29.

## Feature status
| Feature | Status |
|---|---|
| Engine pipeline + providers + credit limits | ✅ real Meta spike-validated + wired as async jobs |
| Play Your Photo (upload or theme → generate → server-validated play, click either image) | ✅ playable · theme→scene ✅ (VF_THEME_GENERATION) · hints + difficulty ✅ (capability 2) |
| Diferia Online (room/race/best-of-3 UI + DB race guard) | 🟡 local simulation · ⏳ Supabase Realtime wiring |
| QC Trainer + COCO/YOLO export | ✅ playable slice · ⏳ batch dataset review flow |
| Landing "one engine, three uses" | ✅ |

## Built during the hackathon
Everything in this repository: Next.js app, engine, providers, Supabase schema, Python worker, tests, docs — written from scratch during the event. No pre-existing code imported, no third-party images (scenes are procedural/MOCK or Muse Image-generated).

## Built with Muse
This project was built with Meta’s Muse Code as the development partner.

## Known limitations
Real Meta generation runs only when deliberately enabled server-side (`AI_PROVIDER=meta` + kill switch on, per-flag opt-ins — see Configuration); Supabase Realtime multiplayer needs project credentials; jobs/levels live in server memory with best-effort Supabase mirroring.

MIT License — see [LICENSE](LICENSE).
