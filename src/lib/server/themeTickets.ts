import { randomUUID } from 'node:crypto';

/** One-time theme-moderation tickets (in-memory, per process).
 *
 *  Voice dictation ends with a theme CHECK (POST /api/generate with themeCheck):
 *  Spark moderates the dictated text ONCE and also returns its tidied rewrite
 *  (cleanTheme, shown as "Spark suggests"). The check issues this ticket so the
 *  real generation right after doesn't pay a SECOND moderation call — "sin
 *  llamada adicional". The ticket is trusted only server-side and only for the
 *  exact text that was moderated: the raw dictation or the accepted cleanTheme.
 *  Any manual edit invalidates it and the job moderates in-job as before. */
interface ThemeTicket { raw: string; clean: string; expiresAt: number }

const TICKET_TTL_MS = 10 * 60 * 1000;

/** globalThis-backed so dev hot-reloads don't drop issued tickets. */
const store: Map<string, ThemeTicket> =
  ((globalThis as unknown as { __vfThemeTickets?: Map<string, ThemeTicket> }).__vfThemeTickets ??= new Map());

function prune(now: number) {
  for (const [id, t] of store) if (t.expiresAt <= now) store.delete(id);
}

/** Issue a ticket for the moderated pair (raw text, Spark's cleaned rewrite). */
export function issueThemeTicket(raw: string, clean: string, now = Date.now()): string {
  prune(now);
  const id = randomUUID();
  store.set(id, { raw, clean, expiresAt: now + TICKET_TTL_MS });
  return id;
}

/** Consume a ticket: true only if it exists, is unexpired AND the submitted text
 *  is exactly what was moderated (raw or accepted cleanTheme). One-time either
 *  way — a spent or stale ticket never validates twice. */
export function consumeThemeTicket(id: string | undefined, submitted: string, now = Date.now()): boolean {
  if (!id) return false;
  const t = store.get(id);
  if (!t) return false;
  store.delete(id);
  if (t.expiresAt <= now) return false;
  return submitted === t.raw || submitted === t.clean;
}
