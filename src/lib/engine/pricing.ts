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

/** Muse Image (muse-image-1.0): flat $0.01 per generated image — generations AND
 *  edits (the docs list no separate edit price; an edit call returns generated
 *  images under the same model). Failures/safety-filtered images are not billed. */
export const MUSE_IMAGE_USD_PER_IMAGE = 0.01;

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

/** USD cost of one Muse Image response: $0.01 per returned image. Returns null
 *  when the response carries no image list (caller falls back to its estimate). */
export function museImageCostUsd(res: unknown): number | null {
  const data = (res as { data?: unknown[] } | null)?.data;
  return Array.isArray(data) && data.length > 0 ? data.length * MUSE_IMAGE_USD_PER_IMAGE : null;
}
