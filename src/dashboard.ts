import {
  remaining,
  formatReset,
  formatAgo,
  isExhausted,
  nowSec,
} from "./rateLimits.js";
import type { Registry } from "./types.js";

const BAR_WIDTH = 5;
const FULL_BLOCK = "▓";
const EMPTY_BLOCK = "░";

export interface DashboardRow {
  name: string;
  label: string;
  plan: string;
  active: boolean;
  hasData: boolean;
  exhausted: boolean;
  primaryFree: number | null;
  secondaryFree: number | null;
  primaryReset: string;
  secondaryReset: string;
  ago: string;
  source: "live" | "rollout" | null;
  /** The provider rejected this login — limits are not shown; sign in again. */
  expired: boolean;
  /** Set when the numbers on this row are not from a successful current check. */
  note: string;
}

/** Limits this old say nothing about now once a live check has failed. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface DashboardModel {
  rows: DashboardRow[];
  summary: { total: number; withHourly: number; withWeekly: number };
}

/** Build a fixed-width bar for a remaining-percent value (null → unknown). */
export function bar(freePercent: number | null | undefined): string {
  if (freePercent === null || freePercent === undefined) {
    return "?".repeat(BAR_WIDTH);
  }
  const used = 100 - freePercent;
  const filled = Math.round((used / 100) * BAR_WIDTH);
  return FULL_BLOCK.repeat(filled) + EMPTY_BLOCK.repeat(BAR_WIDTH - filled);
}

/**
 * Compute the dashboard view-model from the registry. Rows are sorted by
 * availability (most 5h headroom first; exhausted sink to the bottom).
 */
export function buildDashboard(registry: Registry, now = nowSec()): DashboardModel {
  const rows: DashboardRow[] = Object.entries(registry.sessions).map(([name, meta]) => {
    const expired = meta.authState === "expired";
    const failed = meta.authState === "error";
    const age = meta.rateLimits?.capturedAt ? now * 1000 - meta.rateLimits.capturedAt : Infinity;
    // Old numbers are only trustworthy while live checks keep succeeding.
    const rl = expired || (failed && age > STALE_AFTER_MS) ? null : meta.rateLimits || null;
    const note = expired
      ? "sign-in expired — sign in again"
      : failed
        ? `could not update (${meta.lastError || "error"})`
        : "";
    return {
      expired,
      note,
      name,
      label: meta.email || meta.label || name,
      plan: meta.plan || "—",
      active: registry.active === name,
      hasData: !!rl,
      exhausted: isExhausted(rl, now),
      primaryFree: rl ? remaining(rl.primary, now) : null,
      secondaryFree: rl ? remaining(rl.secondary, now) : null,
      primaryReset: rl ? formatReset(rl.primary, now) : "",
      secondaryReset: rl ? formatReset(rl.secondary, now) : "",
      ago: rl ? formatAgo(rl.capturedAt, now * 1000) : "no data yet",
      // "live" means the last check succeeded, not merely that the data once was live.
      source: meta.authState === "ok" ? (rl?.source ?? null) : rl?.source === "rollout" ? "rollout" : null,
    };
  });

  rows.sort((a, b) => {
    if (a.expired !== b.expired) return a.expired ? 1 : -1;
    if (a.exhausted !== b.exhausted) return a.exhausted ? 1 : -1;
    const ap = a.primaryFree ?? 100;
    const bp = b.primaryFree ?? 100;
    if (bp !== ap) return bp - ap;
    const as = a.secondaryFree ?? 100;
    const bs = b.secondaryFree ?? 100;
    return bs - as;
  });

  const total = rows.length;
  // Only count headroom we actually know about on a usable login.
  const usable = rows.filter((r) => !r.expired && !r.exhausted);
  const withHourly = usable.filter((r) => r.primaryFree !== null && r.primaryFree > 0).length;
  const withWeekly = usable.filter((r) => r.secondaryFree !== null && r.secondaryFree > 0).length;

  return { rows, summary: { total, withHourly, withWeekly } };
}

function pct(v: number | null): string {
  return v === null || v === undefined ? "  ?%" : `${String(Math.round(v)).padStart(3)}%`;
}

function used(free: number | null): number | null {
  return free === null || free === undefined ? null : 100 - free;
}

/** Plain (no-Ink) renderer for `ls` and subcommand output. */
export function renderPlainDashboard(registry: Registry, now = nowSec()): string {
  const { rows, summary } = buildDashboard(registry, now);
  const lines: string[] = [];
  lines.push(
    `sessions (${summary.total})  ·  ${summary.withHourly} with 5h headroom  ·  ${summary.withWeekly} with weekly headroom`,
  );
  if (rows.length === 0) {
    lines.push("  (no saved sessions — run `codex login` then `codex-session save <name>`)");
    return lines.join("\n");
  }
  for (const r of rows) {
    const marker = r.active ? "●" : " ";
    const flag = r.exhausted ? "  FULL" : "";
    lines.push(`${marker} ${r.name}  (${r.label} · ${r.plan})${flag}`);
    if (r.expired) {
      lines.push(`    ! ${r.note}`);
      continue;
    }
    if (r.note) lines.push(`    ! ${r.note}`);
    lines.push(
      `    5h ${bar(r.primaryFree)} ${pct(used(r.primaryFree))} used · ${pct(r.primaryFree)} free  ${r.primaryReset}`,
    );
    const src = r.source === "live" ? ", live" : "";
    lines.push(
      `    wk ${bar(r.secondaryFree)} ${pct(used(r.secondaryFree))} used · ${pct(r.secondaryFree)} free  ${r.secondaryReset}   (${r.ago}${src})`,
    );
  }
  return lines.join("\n");
}
