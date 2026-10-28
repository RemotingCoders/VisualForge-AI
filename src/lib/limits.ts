export function checkLimits(input: { changes: number; jobsToday: number }, env: Record<string, string | undefined> = process.env) {
  const maxChanges = Number(env.MAX_CHANGES_PER_JOB ?? 10), maxJobs = Number(env.MAX_JOBS_PER_DAY ?? 20);
  if (input.changes < 1) return { ok: false, reason: 'at least 1 change required' };
  if (input.changes > maxChanges) return { ok: false, reason: `max ${maxChanges} changes per job` };
  if (input.jobsToday >= maxJobs) return { ok: false, reason: `daily limit of ${maxJobs} jobs reached — protects Meta credits` };
  return { ok: true, reason: 'ok' };
}
export function estimateCostUSD(changes: number, env: Record<string, string | undefined> = process.env): number {
  return Math.round(Number(env.ESTIMATED_COST_PER_LEVEL_USD ?? 1.5) * (changes / 7) * 100) / 100;
}
