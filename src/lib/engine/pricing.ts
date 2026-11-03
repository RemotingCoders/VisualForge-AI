/**
 * Real Meta API prices — verified 2026-10-31 on the official pricing page
 * (https://dev.meta.ai/docs/pricing-rate-limits). These feed `estimated_cost_usd`
 * in visualforge_ai_calls, which the VF_SPEND_CAP_USD budget (src/lib/server/spend.ts)
 * sums — so they must be the REAL published prices, not approximations.
 * Standard (pay-as-you-go) rates; the discounted contributor-mode rates are not used.
 */

/** Muse Spark (muse-spark-1.3), Standard, USD per 1M tokens. Image inputs are
 *  tokenized by resolution and billed as input tokens — there is no per-image fee. */
export const SPARK_USD_PER_1M_TOKENS = { input: 1.25, cachedInput: 0.15, output: 4.25 } as const;

/** SAM 3.1 image segmentation: $2.50 per 1,000 images (streaming or not). Every
 *  samSegmentConcept call sends exactly ONE image, so this is the per-call price. */
export const SAM_USD_PER_IMAGE = 0.0025;

/** Muse Image (muse-image-1.0) GENERATIONS: flat $0.01 per generated image.
 *  Failures/safety-filtered images are not billed. EDITS are priced separately
 *  below — the page lists no per-token price for this model at all. */
export const MUSE_IMAGE_USD_PER_IMAGE = 0.01;

/** Muse Image EDITS: the pricing page (re-verified 2026-11-02) lists NO
 *  per-token price for Muse Image — only the flat $0.01 per generated image
 *  above, with edit `usage` returned "for reference" only. But edits return
 *  20k–28k input tokens and the Meta dashboard shows ≈ $0.50 per edit
 *  (~$122 over ~50 generated levels), so this constant is EMPIRICAL —
 *  calibrated against the dashboard, not a published price. Every
 *  /images/edits call is costed with it, so `estimated_cost_usd` — and the
 *  VF_SPEND_CAP_USD accumulated total that sums it — reflects real spend. */
export const MUSE_IMAGE_EDIT_USD_FALLBACK = 0.50;

export interface SparkUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/** USD cost of one Spark Responses call from its reported token usage. */
export function sparkCostUsd(usage?: SparkUsage | null): number {
  if (!usage) return 0;
  const input = Math.max(0, usage.input_tokens ?? 0);
  const cached = Math.min(input, Math.max(0, usage.input_tokens_details?.cached_tokens ?? 0));
  const output = Math.max(0, usage.output_tokens ?? 0);
  return ((input - cached) * SPARK_USD_PER_1M_TOKENS.input
    + cached * SPARK_USD_PER_1M_TOKENS.cachedInput
    + output * SPARK_USD_PER_1M_TOKENS.output) / 1_000_000;
}

/** USD cost of one Muse Image response: generations $0.01 per returned image;
 *  edits the dashboard-calibrated $0.50 fallback per returned image (the page
 *  lists no Muse Image token price, so the edit `usage` cannot be priced
 *  per token). Returns null when the response carries no image list (caller
 *  falls back to its estimate). */
export function museImageCostUsd(res: unknown, isEdit = false): number | null {
  const data = (res as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.length * (isEdit ? MUSE_IMAGE_EDIT_USD_FALLBACK : MUSE_IMAGE_USD_PER_IMAGE);
}
