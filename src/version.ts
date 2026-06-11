import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { MANAGER_HOME } from "./paths.js";

const PKG = "claudecodex";
const REGISTRY = `https://registry.npmjs.org/${PKG}/latest`;
const CACHE_FILE = path.join(MANAGER_HOME, "update-check.json");
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // re-check the registry at most twice a day

/** This build's version, read from the packaged package.json at runtime. */
export function currentVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Running through `npx` (always latest already) rather than a global install. */
function isNpx(): boolean {
  const hay = `${import.meta.url} ${process.argv[1] ?? ""} ${process.env.npm_config_user_agent ?? ""}`;
  return hay.includes("/_npx/") || hay.includes("npx");
}

function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map((n) => parseInt(n, 10) || 0);
  const b = current.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

interface Cache {
  checkedAt: number;
  latest: string | null;
}

function readCache(): Cache | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cache;
  } catch {
    return null;
  }
}

function writeCache(c: Cache): void {
  try {
    fs.mkdirSync(MANAGER_HOME, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch {
    /* best effort */
  }
}

async function fetchLatest(): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(REGISTRY, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Latest version, using the on-disk cache unless it's stale. */
async function resolveLatest(force = false): Promise<string | null> {
  const cached = readCache();
  if (!force && cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.latest;
  }
  const latest = await fetchLatest();
  writeCache({ checkedAt: Date.now(), latest: latest ?? cached?.latest ?? null });
  return latest ?? cached?.latest ?? null;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/**
 * On startup: if a newer published version exists, offer to update. Interactive
 * + global install → prompt, run `npm i -g`, and re-exec the new binary. Non-TTY
 * or npx → just print a one-line notice and continue. Opt out with
 * CLAUDECODEX_NO_UPDATE=1.
 */
export async function maybePromptUpdate(): Promise<void> {
  if (process.env.CLAUDECODEX_NO_UPDATE === "1") return;

  const current = currentVersion();
  let latest: string | null;
  try {
    latest = await resolveLatest();
  } catch {
    return;
  }
  if (!latest || !isNewer(latest, current)) return;

  const banner = `${C.yellow("●")} update available: ${C.dim(current)} → ${C.green(C.bold(latest))}`;

  // Non-interactive or npx: notify and move on.
  if (!process.stdin.isTTY || !process.stdout.isTTY || isNpx()) {
    process.stderr.write(`${banner}   ${C.dim("npm i -g claudecodex@latest")}\n`);
    return;
  }

  process.stderr.write(`\n${banner}\n`);
  const answer = (await ask(`  Update now? ${C.dim("[Y/n]")} `)).trim().toLowerCase();
  if (answer === "n" || answer === "no") {
    process.stderr.write(C.dim("  Skipped. Continuing on current version.\n\n"));
    return;
  }

  process.stderr.write(C.cyan("  Updating via npm…\n"));
  const install = spawnSync("npm", ["install", "-g", `${PKG}@latest`], { stdio: "inherit" });
  if (install.status !== 0) {
    process.stderr.write(C.yellow("  Update failed. Continuing on current version.\n"));
    process.stderr.write(C.dim("  You can update manually: npm i -g claudecodex@latest\n\n"));
    return;
  }

  // Re-exec the freshly installed binary with the same arguments, then exit.
  process.stderr.write(C.green(`  Updated to ${latest}. Restarting…\n\n`));
  const rerun = spawnSync(process.argv[0], process.argv.slice(1), { stdio: "inherit" });
  process.exit(rerun.status ?? 0);
}
