import React, { type MutableRefObject } from "react";
import { Box, Text } from "ink";
import { buildDashboard, bar, type DashboardRow } from "../dashboard.js";
import type { Registry } from "../types.js";

function freeColor(free: number | null, exhausted: boolean): string {
  if (exhausted) return "red";
  if (free === null || free === undefined) return "gray";
  if (free > 50) return "green";
  if (free > 10) return "yellow";
  return "red";
}

function pctText(v: number | null): string {
  if (v === null || v === undefined) return "  ?%";
  return `${String(Math.round(v)).padStart(3)}%`;
}

function WindowLine({
  tag,
  free,
  reset,
  exhausted,
}: {
  tag: string;
  free: number | null;
  reset: string;
  exhausted: boolean;
}) {
  const color = freeColor(free, exhausted);
  const used = free === null || free === undefined ? null : 100 - free;
  return (
    <Box>
      <Text dimColor>{`      ${tag} `}</Text>
      <Text color={color}>{bar(free)}</Text>
      <Text color={color} bold>{` ${pctText(used)} used`}</Text>
      <Text dimColor>{` · ${pctText(free)} free`}</Text>
      {reset ? <Text dimColor>{`   ${reset}`}</Text> : null}
    </Box>
  );
}

function SessionRow({ row, selected, accent }: { row: DashboardRow; selected: boolean; accent: string }) {
  const marker = row.active ? "●" : selected ? "▌" : " ";
  const markerColor = row.active ? "cyanBright" : selected ? accent : "gray";
  const nameColor = selected ? "whiteBright" : row.exhausted ? "red" : "white";
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={markerColor} bold>{`${marker} `}</Text>
        <Text color={nameColor} bold={selected}>{row.name}</Text>
        <Text dimColor>{`  ${row.label} · ${row.plan}`}</Text>
        {row.active ? <Text color="cyanBright">{"  ‹active›"}</Text> : null}
        {row.exhausted ? <Text color="black" backgroundColor="red" bold>{" FULL "}</Text> : null}
      </Box>
      <WindowLine tag="5h" free={row.primaryFree} reset={row.primaryReset} exhausted={row.exhausted} />
      <Box>
        <WindowLine tag="7d" free={row.secondaryFree} reset={row.secondaryReset} exhausted={row.exhausted} />
        <Text dimColor>{`   ${row.ago}${row.source === "live" ? " · live" : ""}`}</Text>
      </Box>
    </Box>
  );
}

interface Props {
  registry: Registry;
  selectedIndex: number;
  rowsRef: MutableRefObject<DashboardRow[]>;
  refreshing?: boolean;
  providerLabel?: string;
  accent?: string;
}

/**
 * Pinned, live dashboard panel. Lives in the always-redrawn Ink frame, so it
 * stays put while the menu/status below it changes — the same approach Claude
 * Code uses for its sticky header.
 */
export default function Dashboard({
  registry,
  selectedIndex,
  rowsRef,
  refreshing,
  providerLabel,
  accent = "cyan",
}: Props) {
  const { rows, summary } = buildDashboard(registry);
  rowsRef.current = rows;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Box>
        <Text bold color={accent}>{providerLabel ?? "sessions"}</Text>
        <Text dimColor>{`  ${summary.total} session${summary.total === 1 ? "" : "s"}`}</Text>
        <Text dimColor>{"   ·   "}</Text>
        <Text color="green">{`${summary.withHourly}`}</Text>
        <Text dimColor>{" with 5h headroom · "}</Text>
        <Text color="green">{`${summary.withWeekly}`}</Text>
        <Text dimColor>{" weekly"}</Text>
        {refreshing ? <Text color="yellow">{"   ⟳ updating…"}</Text> : null}
      </Box>
      <Box height={1} />
      {rows.length === 0 ? (
        <Text dimColor>{"  No sessions yet — [g] sign in · [s] save current login · [a] paste a token from clipboard"}</Text>
      ) : (
        rows.map((row, i) => <SessionRow key={row.name} row={row} selected={i === selectedIndex} accent={accent} />)
      )}
    </Box>
  );
}
