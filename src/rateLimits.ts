import type { RateLimits, RateWindow, SessionMeta } from "./types.js";

export const PRIMARY_LABEL = "5h";
export const SECONDARY_LABEL = "wk";

export interface RankedSession {
  name: string;
  meta: SessionMeta;
  exhausted: boolean;
  primaryFree: number;
  secondaryFree: number;
  hasData: boolean;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Effective used percent for one window, reset-aware: a window whose resets_at
 * is already in the past is treated as fully reset (0% used).
 */
export function effectiveUsedPercent(
  window: RateWindow | null | undefined,
  now = nowSec(),
): number | null {
  if (!window || typeof window.used_percent !== "number") return null;
  // resets_at of 0 means "unknown" (the API omitted it), not "expired".
  if (typeof window.resets_at === "number" && window.resets_at > 0 && window.resets_at <= now) {
    return 0;
  }
  return window.used_percent;
}

/** Remaining percent for a window (null when no data → treated as free). */
export function remaining(
  window: RateWindow | null | undefined,
  now = nowSec(),
): number | null {
  const used = effectiveUsedPercent(window, now);
  if (used === null) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

/** Human reset string for a window. */
export function formatReset(window: RateWindow | null | undefined, now = nowSec()): string {
  if (!window || typeof window.resets_at !== "number" || window.resets_at <= 0) return "";
  const delta = window.resets_at - now;
  if (delta <= 0) return "reset";
  const d = Math.floor(delta / 86400);
  const h = Math.floor((delta % 86400) / 3600);
  const m = Math.floor((delta % 3600) / 60);
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

/** Generic "x ago" for the capturedAt timestamp (ms). */
export function formatAgo(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const delta = Math.floor((now - ms) / 1000);
  if (delta < 60) return "just now";
  const m = Math.floor(delta / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Is the session out of quota right now (reset-aware)? */
export function isExhausted(rateLimits: RateLimits | null | undefined, now = nowSec()): boolean {
  if (!rateLimits) return false;
  const p = effectiveUsedPercent(rateLimits.primary, now);
  const s = effectiveUsedPercent(rateLimits.secondary, now);
  return (p !== null && p >= 99) || (s !== null && s >= 99);
}

/**
 * Score helper for ranking: unknown windows are treated as 100% free, since an
 * account we've never observed is most likely fresh.
 */
function remainingOrFree(window: RateWindow | null | undefined, now: number): number {
  const r = remaining(window, now);
  return r === null ? 100 : r;
}

/**
 * Pick the best session to switch to: drop exhausted ones, then sort by 5h
 * remaining (desc), tie-break by weekly remaining (desc). Returns null if every
 * session is exhausted.
 */
export function pickBest(
  sessions: Array<{ name: string; meta: SessionMeta }>,
  now = nowSec(),
): RankedSession | null {
  const candidates: RankedSession[] = sessions
    .map(({ name, meta }) => {
      const rl = meta.rateLimits || null;
      return {
        name,
        meta,
        exhausted: isExhausted(rl, now),
        primaryFree: remainingOrFree(rl?.primary, now),
        secondaryFree: remainingOrFree(rl?.secondary, now),
        hasData: !!rl,
      };
    })
    .filter((c) => !c.exhausted);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.primaryFree !== a.primaryFree) return b.primaryFree - a.primaryFree;
    if (b.secondaryFree !== a.secondaryFree) return b.secondaryFree - a.secondaryFree;
    if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
    return 0;
  });

  return candidates[0];
}

export interface SoonestReset {
  name: string;
  resets_at: number;
  window: RateWindow;
}

/** Among exhausted sessions, the one resetting soonest (for the all-full hint). */
export function soonestReset(
  sessions: Array<{ name: string; meta: SessionMeta }>,
  now = nowSec(),
): SoonestReset | null {
  let best: SoonestReset | null = null;
  for (const { name, meta } of sessions) {
    const rl = meta.rateLimits;
    if (!rl) continue;
    for (const w of [rl.primary, rl.secondary]) {
      if (w && typeof w.resets_at === "number" && w.resets_at > now) {
        if (!best || w.resets_at < best.resets_at) {
          best = { name, resets_at: w.resets_at, window: w };
        }
      }
    }
  }
  return best;
}
