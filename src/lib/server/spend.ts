import { NextResponse } from 'next/server';
import { getServiceClient } from './supabase';
import { MUSE_IMAGE_EDIT_USD_FALLBACK } from '../engine/pricing';

/**
 * VF_SPEND_CAP_USD + VF_SPEND_CAP_SINCE — the global judging-period budget, the
 * SECOND layer of public-demo protection (the first is the VF_ACCESS_CODE gate in
 * access.ts). Before any paid call, the Meta-calling routes sum the REAL estimated
 * costs recorded in visualforge_ai_calls since VF_SPEND_CAP_SINCE; at or over the
 * cap they answer 429 and only the free surfaces keep working (gallery, stored
 * levels, clicks, saved hints, exports). Unset cap = no budget limit (local dev).
 * Without Supabase (tests, offline), an in-memory ledger fed by logAiCall stands in.
 */
export const SPEND_CAP_EXHAUSTED_MESSAGE = 'Budget for the judging period is exhausted; the gallery remains playable';

export interface SpendCapConfig { capUsd: number; since: Date }

export function spendCapConfig(env: Record<string, string | undefined> = process.env): SpendCapConfig | null {
  const capUsd = Number(env.VF_SPEND_CAP_USD);
  if (!Number.isFinite(capUsd) || capUsd <= 0) return null;
  const parsed = env.VF_SPEND_CAP_SINCE ? Date.parse(env.VF_SPEND_CAP_SINCE) : NaN;
  // Unset/unparseable SINCE counts from the epoch: when in doubt, count everything.
  return { capUsd, since: new Date(Number.isNaN(parsed) ? 0 : parsed) };
}

interface SpendEntry { usd: number; at: number; operation?: string }
const g = globalThis as unknown as { __vfSpendLedger?: SpendEntry[]; __vfModelTokens?: Record<string, ModelTokenTotals> };
if (!g.__vfSpendLedger) g.__vfSpendLedger = [];

/** Fed by logAiCall (db.ts) with every real call's estimated cost, so the budget
 *  also works with no Supabase configured. The operation (API path) rides along
 *  so historical Muse Image EDIT entries can be repriced at read time (below). */
export function recordSpend(usd: number, at: number = Date.now(), operation?: string): void {
  if (Number.isFinite(usd) && usd > 0) g.__vfSpendLedger!.push({ usd, at, operation });
}

/** Muse Image EDITS were recorded at the flat $0.01/image price before the
 *  dashboard-calibrated $0.50/edit fallback existed (pricing.ts, 2026-11-02),
 *  which under-counted the cap total by ~50× per edit. The accumulated total
 *  reprices edit calls at read time: an `/images/edits` row counts at least
 *  MUSE_IMAGE_EDIT_USD_FALLBACK. Idempotent — rows already written with the
 *  fallback carry it, so nothing is double-counted. */
const correctedEntryUsd = (usd: number, operation?: string | null): number =>
  operation?.includes('images/edits') ? Math.max(usd, MUSE_IMAGE_EDIT_USD_FALLBACK) : usd;

function memorySpendSince(since: Date): number {
  const t = since.getTime();
  return g.__vfSpendLedger!.reduce((sum, e) => (e.at >= t ? sum + correctedEntryUsd(e.usd, e.operation) : sum), 0);
}

/** Total estimated spend (USD) inside the cap window: SUM over
 *  visualforge_ai_calls since VF_SPEND_CAP_SINCE, with historical Muse Image
 *  edit rows repriced to the $0.50 fallback (see correctedEntryUsd);
 *  in-memory ledger as fallback. */
export async function spendTotalUsd(env: Record<string, string | undefined> = process.env): Promise<number> {
  const since = spendCapConfig(env)?.since ?? new Date(0);
  const sb = getServiceClient();
  if (sb) {
    try {
      const { data, error } = await sb.from('visualforge_ai_calls')
        .select('estimated_cost_usd, operation').gte('created_at', since.toISOString()).limit(100_000);
      if (!error && data) return data.reduce((sum, r) => sum + correctedEntryUsd(Number(r.estimated_cost_usd) || 0, r.operation as string | null), 0);
    } catch { /* fall through to the in-memory ledger */ }
  }
  return memorySpendSince(since);
}

/** Per-model token totals (input/output), fed by metaPost for every real call
 *  whose response carries `usage` (Spark calls AND Muse Image edits — the
 *  20k–28k input tokens per edit are exactly what the $0.50 fallback stands
 *  in for). Each job snapshots the totals at start and logs its per-model
 *  delta at the end (jobs.ts), so token consumption is visible per model. */
export interface ModelTokenTotals { input: number; output: number }
if (!g.__vfModelTokens) g.__vfModelTokens = {};

export function recordModelTokens(model: string, input: number, output: number): void {
  const t = g.__vfModelTokens![model] ?? (g.__vfModelTokens![model] = { input: 0, output: 0 });
  t.input += Math.max(0, input || 0);
  t.output += Math.max(0, output || 0);
}

/** Snapshot of the running per-model token totals (job deltas diff two of these). */
export function modelTokenTotals(): Record<string, ModelTokenTotals> {
  return Object.fromEntries(Object.entries(g.__vfModelTokens!).map(([m, t]) => [m, { ...t }]));
}

/** The cap gate every Meta-calling route passes right after the access-code check:
 *  returns the 429 response to send, or null when paid work may proceed. */
export async function enforceSpendCap(env: Record<string, string | undefined> = process.env): Promise<NextResponse | null> {
  const cfg = spendCapConfig(env);
  if (!cfg) return null;
  const spent = await spendTotalUsd(env);
  if (spent < cfg.capUsd) return null;
  console.info(`[spend] budget exhausted: $${spent.toFixed(4)} spent since ${cfg.since.toISOString()} (cap $${cfg.capUsd.toFixed(2)}) — Meta-calling routes now answer 429`);
  return NextResponse.json({ error: SPEND_CAP_EXHAUSTED_MESSAGE }, { status: 429 });
}
