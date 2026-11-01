import { NextResponse } from 'next/server';
import { getServiceClient } from './supabase';

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

interface SpendEntry { usd: number; at: number }
const g = globalThis as unknown as { __vfSpendLedger?: SpendEntry[] };
if (!g.__vfSpendLedger) g.__vfSpendLedger = [];

/** Fed by logAiCall (db.ts) with every real call's estimated cost, so the budget
 *  also works with no Supabase configured. */
export function recordSpend(usd: number, at: number = Date.now()): void {
  if (Number.isFinite(usd) && usd > 0) g.__vfSpendLedger!.push({ usd, at });
}

function memorySpendSince(since: Date): number {
  const t = since.getTime();
  return g.__vfSpendLedger!.reduce((sum, e) => (e.at >= t ? sum + e.usd : sum), 0);
}

/** Total estimated spend (USD) inside the cap window: SUM(estimated_cost_usd) over
 *  visualforge_ai_calls since VF_SPEND_CAP_SINCE; in-memory ledger as fallback. */
export async function spendTotalUsd(env: Record<string, string | undefined> = process.env): Promise<number> {
  const since = spendCapConfig(env)?.since ?? new Date(0);
  const sb = getServiceClient();
  if (sb) {
    try {
      const { data, error } = await sb.from('visualforge_ai_calls')
        .select('estimated_cost_usd').gte('created_at', since.toISOString()).limit(100_000);
      if (!error && data) return data.reduce((sum, r) => sum + (Number(r.estimated_cost_usd) || 0), 0);
    } catch { /* fall through to the in-memory ledger */ }
  }
  return memorySpendSince(since);
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
