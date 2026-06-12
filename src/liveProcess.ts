import { execFileSync } from "node:child_process";

/** Command the user runs to continue their last chat under the new account. */
export const RESUME_HINT: Record<string, string> = {
  codex: "codex resume --last",
  claude: "claude --continue",
};

/**
 * Whether a provider's running CLI picks up swapped credentials without a
 * restart. Claude Code re-reads its credentials, so it hot-swaps; Codex loads
 * auth.json once at startup and keeps it in memory until the process exits
 * (openai/codex#17041).
 */
export const HOT_SWAP: Record<string, boolean> = {
  codex: false,
  claude: true,
};

/**
 * Count running CLI processes for a provider (exact basename match, so IDE
 * extension instances count too — they hold the old token just the same).
 * Best-effort: returns 0 on platforms/setups where detection isn't possible.
 */
export function runningProcessCount(providerId: string): number {
  if (process.platform === "win32") return 0;
  try {
    const out = execFileSync("ps", ["-axo", "comm="], { encoding: "utf8" });
    return out
      .split("\n")
      .filter((line) => line.trim().split("/").pop() === providerId).length;
  } catch {
    return 0;
  }
}

/**
 * Warning shown after switching the active session while the provider's CLI
 * is still running: a live process keeps the previous account's token in
 * memory (and writes it back to disk on its next token refresh), so the
 * switch only fully takes effect once those processes restart.
 */
export function midSwitchWarning(providerId: string): string | null {
  const n = runningProcessCount(providerId);
  if (n === 0) return null;
  if (HOT_SWAP[providerId]) {
    return `Running ${providerId} session${n === 1 ? "" : "s"} will pick up the new account automatically.`;
  }
  const what = n === 1 ? `a ${providerId} process is` : `${n} ${providerId} processes are`;
  const resume = RESUME_HINT[providerId] ?? providerId;
  return `⚠ ${what} still running on the previous account — close ${n === 1 ? "it" : "them"}, then continue your chat with \`${resume}\`.`;
}
