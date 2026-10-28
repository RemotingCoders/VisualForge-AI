# AI Integration — Phase 0 status

**Status: 🟡 APPROVED by Damian 2026-10-28 (max 6 paid calls, report cost of each). Providers IMPLEMENTED from the official docs he pasted 2026-10-28 (`/docs/sam/segmenting`, `/docs/sam/reading-segmentation`, `/docs/structured-output`, saved in `~/Documents/metadocs`). Spike NOT yet executed: per his order, Vitest + pytest + Playwright must pass and phases be committed first. Zero paid calls made so far.**

## Verified API reference (dev.meta.ai/docs, pasted by Damian 2026-10-28)
- **Base URL:** `https://api.meta.ai/v1` · **Auth:** `Authorization: Bearer $MODEL_API_KEY` (key set by Damian in `.env.local`, never via chat)
- **Model IDs:** `muse-image-1.0`, `sam-3.1`, `muse-spark-1.3`
- **Muse Image edit:** `POST /v1/images/edits` `{model, prompt, images:[{image_url:"data:image/...;base64,..."}], n}` — **no mask parameter in docs.** Strategy (approved): crop the SAM region + margin → edit crop → composite back with feathered mask → real differences from pixel diff. Spike also tests whether a full-image edit respects the untouched rest.
- **SAM 3.1 segment:** `POST /v1/responses` `{model:"sam-3.1", input:[{type:"message",role:"user",content:[{type:"input_text",text:"<ONE short noun phrase>"},{type:"input_image",image_url}]}], stream:true, metadata:{include_confidence:"true", mask_encoding:"one_bit"}}`. One concept per request (comma lists return zero matches; no negation/questions). SSE events `response.output_text.delta`; zero matches = empty output, valid.
- **SAM output grammar:** `<0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..[;c=0..1]|><|mask;x=0;y=0[;c=..];data=H,W,ENC+payload|>` — box in source pixels, `data=` is **H (rows) first**, ENC `~`=lossless / `!`=one_bit, payload **base85**. Object ids stable but sparse. Implemented: [meta.ts](../src/lib/engine/meta.ts) `parseSamOutput` (fields parsed by key), unit-tested with fake fetch — no paid calls in tests.
- **SAM mask → raster:** `decodeMaskToRaster` exists ONLY in the official client libraries (`@meta-sam/parser` ≥ 0.0.13 / `meta-sam-parser` ≥ 0.0.6; details on `/docs/sam/client-libraries`, **not yet pasted**). Our `decodeMaskToRaster` stays a loud stub — the pipeline does not need it: real masks/bboxes are measured from pixel diff, SAM boxes seed the crop.
- **Muse Spark structured output:** Responses API → `text:{format:{type:"json_schema", name, schema, strict:true}}` (Chat Completions uses `response_format` instead; a parameter from the other endpoint does not configure it). Result is a JSON string in `output_text`. Schemas must satisfy the strict subset: root object, `additionalProperties:false`, `required` lists every property, no recursion, depth ≤ 10. Implemented: `sparkStructured` + `SPARK_SCHEMAS` in [providers.ts](../src/lib/engine/providers.ts) (moderation / concepts / plan / verification).
- **Muse Spark scene → SAM workflow (per docs):** Spark lists segmentable concepts → SAM segments each concept. Implemented in `MetaProvider.segment` (max 8 concepts).
- **Still unverified (not guessed):** Muse Image *generation* request shape (scene generation stays `MetaNotConfiguredError`); Muse Image edit *response* shape (spike step 3/4 saves the raw response); Spark image parts use the verified Responses `input_image` shape.

## Spike plan (ledger-enforced, [scripts/meta-spike.mjs](../scripts/meta-spike.mjs) + `spike-ledger.json`, one step per run)
| # | Call | Purpose | Cost |
|---|------|---------|------|
| 1 | SAM 3.1 segment (`--step=1 --concept=...`) | regions + masks on 1 test image | _after run_ |
| 2 | Muse Spark JSON plan (`--step=2`) | structured plan reusing step-1 boxes | _after run_ |
| 3 | Muse Image edit crop (`--step=3`) | masked-region strategy validation | _after run_ |
| 4 | Muse Image edit full image (`--step=4`) | does it respect untouched pixels? compare | _after run_ |
| 5 | Muse Spark verify (`--step=5`) | original vs edited per region | _after run_ |
| 6 | reserve | one retry only | — |

Note: if the API does not return dollar cost, each call's latency/usage is logged and the $ figure must be read from the Meta dashboard — reported, never invented. Step 1 saves the raw SSE (`spike-output/sam-raw.txt`) so mask-decoding experiments offline are free.

## Rules enforced in code
- Paid calls require `META_REAL_CALLS_ENABLED=true` **and** `--i-approve-paid-calls` **and** `MODEL_API_KEY`; ledger refuses beyond 6 calls. No calls in tests/setup. Per-job/daily limits in [limits.ts](../src/lib/limits.ts); every call logged to `ai_calls`.
- Providers behind interfaces; anything unverified throws instead of guessing. Mock labeled in UI and outputs — no silent fallback.
