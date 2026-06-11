import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const HOME = os.homedir();

// ---- Codex CLI locations ----
export const CODEX_HOME = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(HOME, ".codex");
export const CODEX_LIVE_AUTH = path.join(CODEX_HOME, "auth.json");
export const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");

// ---- This manager's own state ----
export const MANAGER_HOME = process.env.CLAUDECODEX_HOME
  ? path.resolve(process.env.CLAUDECODEX_HOME)
  : path.join(HOME, ".claudecodex");

/** Per-provider state directory, e.g. ~/.claudecodex/codex, ~/.claudecodex/claude. */
export function providerStateDir(providerId: string): string {
  return path.join(MANAGER_HOME, providerId);
}

export function registryFile(dir: string): string {
  return path.join(dir, "registry.json");
}
export function snapshotsDir(dir: string): string {
  return path.join(dir, "sessions");
}
export function snapshotPath(dir: string, name: string): string {
  return path.join(snapshotsDir(dir), `${name}.json`);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(snapshotsDir(dir), { recursive: true });
}

/**
 * One-time migration of the previous single-provider layout
 * (~/.codex-multi-session) into ~/.claudecodex/codex.
 */
export function migrateLegacyCodex(): void {
  const legacy = path.join(HOME, ".codex-multi-session");
  const target = providerStateDir("codex");
  try {
    if (!fs.existsSync(path.join(legacy, "registry.json"))) return;
    if (fs.existsSync(registryFile(target))) return; // already migrated
    ensureDir(target);
    fs.copyFileSync(path.join(legacy, "registry.json"), registryFile(target));
    const legacySessions = path.join(legacy, "sessions");
    if (fs.existsSync(legacySessions)) {
      for (const f of fs.readdirSync(legacySessions)) {
        fs.copyFileSync(path.join(legacySessions, f), path.join(snapshotsDir(target), f));
        try {
          fs.chmodSync(path.join(snapshotsDir(target), f), 0o600);
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* migration is best-effort */
  }
}
