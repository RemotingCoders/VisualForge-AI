# VisualForge AI — Diferia & QC Inspection Trainer

**One verified visual-difference engine, three experiences.** Given any image, VisualForge produces a modified version with realistic, localized, *verified* changes — plus the exact bounding box and mask of each change.

Built by **Damian Sinay** (indie developer) for the **Meta Global AI Developer Hackathon 2026**, Indie Developer track, theme *"Build for Your World"*. **Deadline: Wed Nov 4, 9:00 PM ET.** Live demo URL and judge access code are provided in the hackathon submission form.

## The three experiences
1. **🔎 Diferia: Play Your Photo** — upload your photo or describe a theme → the engine forges N differences → play in the browser (timer, limited mistakes, hints, score, shareable link; clicks validated server-side, annotations never leak early).
2. **🏭 QC Inspection Trainer** — the same engine generates realistic product defects (scratch, crack, dent, missing component…) to train inspectors and export labeled **COCO JSON / YOLO** datasets. *Synthetic — validate before industrial use.*
3. **🤖 Challenge the AI inspector** — race Muse Spark itself: one Spark call inspects the defective unit (no reference by default, or with the known-good reference) and its findings are validated server-side against the real boxes (finding box expanded 16 px overlapping the real bbox, or either center inside the other; per-finding calibration logged). Beat the AI on coverage, then on time — in QC and, as "Race against Spark", in Play. Each challenge accumulates per-difference Spark *detectability* (migration `0006`), shown in the QC reveal and exported in COCO.

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
- `VF_THEME_GENERATION=true`: enables theme→scene generation on `/play`. Flow: Muse Spark **text-only moderation first** (a rejected theme never reaches a paid call and fails as `theme_rejected`), then one Muse Image generation (`POST /v1/images/generations`, docs-verified shape: aspect-only `size`, no `moderation` field — that enum is Spark-only; flat $0.01/image, logged per call in `visualforge_ai_calls`), then the standard pipeline. The theme and the model's `revised_prompt` are stored on the level (migration `0003_level_theme.sql`; pre-0003 databases simply persist without them). The theme box (Play) and the describe-a-part box (QC) also support **voice dictation** (Web Speech API where the browser offers it; interim results land in the field live, auto-stop after 3 s of silence): when dictation stops, that same single Spark moderation call also returns a tidied rewrite of the dictated text (`cleanTheme`, same language, fillers and spoken self-corrections dropped), offered inline as "✨ Spark suggests … [Use this] [Keep mine]". A one-time server-side ticket ([src/lib/server/themeTickets.ts](src/lib/server/themeTickets.ts)) ties the dictation check to the following generation, so moderation still happens **exactly once** per theme — any manual edit invalidates the ticket and the job moderates as before.
- `VF_SCENE_REASONING` (`low|medium|high`, default `high`): reasoning effort for the scene-generation call only.
- `VF_SAM_MASKS=true`: use real SAM masks (official `@meta-sam/parser`) for local recolor/compositing, with per-change fallback to bbox behavior.
- Hints & per-difference difficulty (capability 2, always on with the real provider): the level **publishes the moment its differences are measured**; afterwards, **one** Muse Spark call per level runs **in the background** and writes 3 progressive hints and a difficulty rating (1–5) per difference (migration `0004_difference_hints.sql`; pre-0004 databases persist without them). `POST /api/hint` serves the next hint of the easiest pending difference — until the Spark hints land it serves a positional hint derived from the bbox, marked `provisional` (Play labels it "Quick hint"); the score weights each find by its difficulty. One-pass component selection applies a visibility floor by job difficulty as a **priority, not a gate** (easy: area ≥ 0.25 % of the image and mean amplitude ≥ 40; medium: ≥ 0.12 % / ≥ 35; hard: no priority floor): above-floor components are reviewed first, below-floor ones are **held as the last resort** — tried only after the crop path and its replacement plan are exhausted — and an absolute floor rejects specks outright even when the count stays short (easy/medium: area < 0.08 % or amp < 30; hard: 0.04 % / 25).
- Count guarantee (game mode): a level **never ships short**. Order of remedies: one-pass → crop candidates → **replacement plan** (one extra Spark call for the missing count + 2, planned over only the regions that don't overlap an accepted difference) → one completion full-image Muse call asking only for the missing differences → held below-floor one-pass components as the last resort. Still short, the job fails with a clear message ("We could only create X of the N differences…") instead of delivering a short level.
- QC mode (defect counts 1–5): SAM's concept listing asks for **parts/features** of the part, the planner anchors every defect with its own pixel `targetBox` + part name inside a region (several defects may share one region — e.g. the whole part), and overlap is judged only against accepted defects' **measured** boxes (8 px margin), never the region box. One-pass paints defects on the full image first, crops top up, and a short QC level **publishes partial** with a "Generated N of M defects" notice instead of failing. After measurement, **one** Muse Spark call classifies every defect from before/after crops (type within the 8 QC categories, severity 1–5, confidence 0–1, short label; migration `0005_difference_classification.sql`, pre-0005 databases persist without it): exports label with the **classified** type and ship confidence < 0.6 separately as `needs_review` (`/api/qc-export?part=review`). The trainer runs on the real level — server-validated clicks, timer, "Reveal & score" (`GET /api/qc-reveal`, QC levels only) — and saves the session (`visualforge_qc_sessions`, table since migration 0001; in-memory without Supabase). A missing DB column is logged once per process, and a transient network failure inside a Meta call is retried exactly once (2 s) within the per-change budget.
- Challenge the AI inspector (`POST /api/ai-inspect`, no access code; 10 challenges/hour/IP): **one** Muse Spark call per challenge inspects the defective/modified image — `no-reference` (default, target only) or `with-reference` (known-good first) — and returns normalized finding boxes that the **server** validates (finding box expanded 16 px overlapping an unclaimed real bbox, or the center of either box inside the other; each difference claimable once, duplicates count as false positives; every finding is logged against its nearest real box with the center distance, for calibration). The annotations never leave the server. Response: matched findings (with the real classified type / game description), false positives, missed, and the measured Spark latency. Every challenge accumulates per-difference **detectability** (attempts, hits, modes found in; migration `0006_difference_detectability.sql`, best-effort DB mirror), shown in the QC reveal and exported as a COCO annotation attribute. UI: "Challenge the AI inspector" in `/qc` (restarts the human clock, Spark races in parallel, fuchsia boxes, compared verdict) and "Race against Spark" in `/play`.
- Credit guards: `MAX_CHANGES_PER_JOB`, `MAX_JOBS_PER_DAY`, `ESTIMATED_COST_PER_LEVEL_USD` (see [src/lib/limits.ts](src/lib/limits.ts)).
- Public-demo protection for paid generation, all checked before any provider work: `VF_ACCESS_CODE` — when set, `POST /api/generate` requires the judge access code (constant-time comparison, 401 `{ error: "access code required" }` without it; unset = open for local dev). `/play` and `/qc` show a "Judge access code" field next to Generate and remember it in `localStorage`; a 401 tells the visitor they can still play the demo and the gallery. Plus, active in the same public-demo mode, a per-IP limit of 5 generations/hour (in-memory sliding window, 429), and the always-on daily cap now counted from today's `visualforge_generation_jobs` rows (in-memory count as fallback without Supabase). The demo level, the gallery, `/api/validate-click` and `/api/hint` never need the code.
- Level gallery: the landing and `/play` list the 12 most recent published levels from Supabase (`GET /api/gallery`, original-image thumbnails); playing one loads its stored images via `GET /api/level` — it generates nothing (this also makes Play share links work).
- Supabase persistence is best-effort and additive: jobs/levels/differences/images/ai-calls are mirrored to `visualforge_*` tables when `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set; the game also works fully in-memory without them.

## Tests
```bash
npm test            # Vitest: pipeline, composite invariant, mask→bbox, click tolerance, scoring, race, COCO/YOLO, provider, limits
.venv/bin/python -m pytest tests/test_composite.py   # Python env lives in .venv (git-ignored)
npm run test:e2e    # Playwright: single-player flow on MOCK
```
**Status (2026-10-31):** Vitest 101/102 (incl. the async generation loop with fake providers, the one-pass path, duplicate-difference dedupe, the visibility floor as priority with below-floor components held as last resort under an absolute floor, Spark hints + difficulty written in the background after publication, the count-completion guarantee — replacement plan over free regions, then a completion one-pass call, otherwise the job fails loudly — theme generation with voice dictation (Spark `cleanTheme` tidy-up in the same moderation call, one-time pre-check tickets so moderation runs exactly once), the VF_ACCESS_CODE 401/429/pass-through guards on /api/generate, the QC completion suite — multiple defects on one whole-part region, Spark defect classification with needs_review export split, QC-only reveal, saved trainer sessions, one-retry network resilience — the AI-inspector suite (finding validation under the 16 px box-overlap rule with calibration data, coverage-then-speed verdict, detectability accumulation, 10/hour/IP challenge limit) and sharp composite/measurement invariants) and Playwright 1/1 verified 2026-10-30; pytest 2/2 last verified 2026-10-29. Known stale fixture: `tests/onepass-calibration.test.ts` was calibrated against the previous `test.jpeg` (replaced in c9b84ea) and currently finds 0 of its 3 saved edits — it needs re-calibration against the new photo, engine code unchanged.

## Feature status
| Feature | Status |
|---|---|
| Engine pipeline + providers + credit limits | ✅ real Meta spike-validated + wired as async jobs |
| Play Your Photo (upload or theme → generate → server-validated play, click either image) | ✅ playable · theme→scene ✅ (VF_THEME_GENERATION) · hints + difficulty ✅ (capability 2) |
| Challenge the AI inspector (Spark race in QC + Play, detectability) | ✅ one Spark call per challenge, server-validated findings, 10/hour/IP, no access code |
| QC Trainer + COCO/YOLO export | ✅ real-level trainer (server-validated clicks, timer, reveal & score, saved sessions) · multi-defect per part via per-defect targetBox · Spark defect classification (type/severity/confidence, migration 0005) with needs_review export split · partial levels ship with a "Generated N of M defects" notice |
| Public-demo protection (VF_ACCESS_CODE, 5/hour/IP, DB daily cap) + level gallery | ✅ |
| Landing "one engine, three uses" | ✅ |

## Roadmap
- Real-time multiplayer (rooms, presence, first-finder-claims on the DB unique constraint): schema and race guard are in place, UI and Supabase Realtime wiring planned for the next version. Not part of this submission.

## Built during the hackathon
Everything in this repository: Next.js app, engine, providers, Supabase schema, Python worker, tests, docs — written from scratch during the event. No pre-existing code imported, no third-party images (scenes are procedural/MOCK or Muse Image-generated).

## Built with Muse
This project was built with Meta’s Muse Code as the development partner.

## Known limitations
Real Meta generation runs only when deliberately enabled server-side (`AI_PROVIDER=meta` + kill switch on, per-flag opt-ins — see Configuration); jobs/levels live in server memory with best-effort Supabase mirroring.

MIT License — see [LICENSE](LICENSE).
