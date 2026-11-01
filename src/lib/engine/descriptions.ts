/**
 * Description normalization for one-pass dedupe. Spark describes the SAME single
 * change once per split component — "A small red flag appeared at the lower
 * right", "...next to the rock", "...in front of the large rock" — differing
 * ONLY in the location phrase, so exact-text dedupe never fires (field case:
 * one red flag counted as three differences). Cutting the location phrase off
 * makes those descriptions identical, and the server merges them into ONE
 * difference (union box/mask) instead of counting parts of a change.
 */
const LOCATION_PHRASE = /\s(at the|next to|in front of|behind|on the left|on the right|on the top|on the bottom|to the left of|to the right of|in the upper|in the lower|in the top|in the bottom|on the upper|on the lower)\b.*$/;

export function normalizeChangeDescription(description: string): string {
  const cleaned = description.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.replace(LOCATION_PHRASE, '').trim();
}

/** Dedupe key for a reviewed change: type + location-free description. */
export function changeDescriptionKey(type: string, description: string): string {
  return `${(type || 'other').toLowerCase()}|${normalizeChangeDescription(description)}`;
}
