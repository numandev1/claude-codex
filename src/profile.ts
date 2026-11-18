import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CODEX_HOME, providerStateDir } from "./paths.js";

/**
 * Isolated profiles: one directory per account, used through the CLI's own
 * supported home override (CLAUDE_CONFIG_DIR / CODEX_HOME).
 *
 * Unlike `incognito`, nothing here reads, copies, or writes credentials. Each
 * profile is signed in once with the CLI's own login, and the CLI keeps (and
 * refreshes) that login inside the profile from then on. Two terminals on two
 * profiles therefore never see each other's account, and the global login is
 * never touched.
 */
interface ProfileSpec {
  command: string;
  envVar: string;
  /** The user's normal home for this CLI — the source of shared config. */
  home: string;
  /** Config entries symlinked into a new profile, so edits stay in one place. */
  link: string[];
  /** Config files copied once; the profile owns its copy afterwards. */
  copy: string[];
  /** The CLI's own sign-in command. */
  loginArgs: string[];
  /** The CLI's own "am I signed in?" command — it knows which credential store is in use. */
  statusArgs: string[];
  /** Interpret the status command's result. */
  parseStatus(exitCode: number | null, stdout: string): ProfileStatus;
}

export interface ProfileStatus {
  loggedIn: boolean;
  /** Short human-readable detail (account email or login method), when the CLI reports one. */
  detail: string | null;
}

const SPECS: Record<string, ProfileSpec> = {
  claude: {
    command: "claude",
    envVar: "CLAUDE_CONFIG_DIR",
    home: path.join(os.homedir(), ".claude"),
    link: ["settings.json", "CLAUDE.md", "keybindings.json", "agents", "commands", "skills", "ninjutsai"],
    copy: [],
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status", "--json"],
    parseStatus(exitCode, stdout) {
      try {
        const j = JSON.parse(stdout);
        return { loggedIn: j.loggedIn === true, detail: j.email || j.authMethod || null };
      } catch {
        return { loggedIn: false, detail: null };
      }
    },
  },
  codex: {
    command: "codex",
    envVar: "CODEX_HOME",
    home: CODEX_HOME,
    link: ["AGENTS.md", "prompts"],
    copy: ["config.toml"],
    loginArgs: ["login"],
    statusArgs: ["login", "status"],
    parseStatus(exitCode, stdout) {
      const loggedIn = exitCode === 0;
      return { loggedIn, detail: loggedIn ? stdout.trim().split("\n")[0] || null : null };
    },
  },
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function spec(providerId: string): ProfileSpec {
  const s = SPECS[providerId];
  if (!s) throw new Error(`Isolated profiles are not supported for "${providerId}".`);
  return s;
}

export function profilesRoot(providerId: string): string {
  return path.join(providerStateDir(providerId), "profiles");
}

export function profileDir(providerId: string, name: string): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid profile name "${name}" — use letters, digits, ".", "_" or "-".`);
  }
  return path.join(profilesRoot(providerId), name);
}

export function listProfiles(providerId: string): string[] {
  try {
    return fs
      .readdirSync(profilesRoot(providerId), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Create the profile dir if needed and share the user's config into it. Idempotent. */
export function prepareProfile(providerId: string, name: string): { dir: string; created: boolean } {
  const s = spec(providerId);
  const dir = profileDir(providerId, name);
  const created = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Never overwrite: anything already in the profile belongs to the profile.
  const missing = (dst: string) => fs.lstatSync(dst, { throwIfNoEntry: false }) === undefined;
  for (const entry of s.link) {
    const src = path.join(s.home, entry);
    const dst = path.join(dir, entry);
    if (fs.existsSync(src) && missing(dst)) fs.symlinkSync(src, dst);
  }
  for (const entry of s.copy) {
    const src = path.join(s.home, entry);
    const dst = path.join(dir, entry);
    if (fs.existsSync(src) && missing(dst)) fs.copyFileSync(src, dst);
  }
  return { dir, created };
}

export function profileEnv(providerId: string, name: string): Record<string, string> {
  return { [spec(providerId).envVar]: profileDir(providerId, name) };
}

function runChild(command: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
    // Ctrl+C reaches the foreground child through the shared TTY; this wrapper
    // must outlive it so the child's exit code is what gets reported.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const cleanup = () => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
    };
    child.on("error", (err) => {
      cleanup();
      reject(new Error(`Could not start \`${command}\`: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/**
 * Ask the CLI itself whether the profile is signed in. This is a local check of
 * the profile's credential store (file or OS keychain, whichever the CLI is
 * configured for) — it does not prove the login is still accepted by the server.
 */
export function profileStatus(providerId: string, name: string): ProfileStatus {
  const s = spec(providerId);
  const dir = profileDir(providerId, name);
  if (!fs.existsSync(dir)) return { loggedIn: false, detail: null };
  const r = spawnSync(s.command, s.statusArgs, {
    env: { ...process.env, ...profileEnv(providerId, name) },
    encoding: "utf8",
    timeout: 20_000,
  });
  if (r.error) throw new Error(`Could not run \`${s.command} ${s.statusArgs.join(" ")}\`: ${r.error.message}`);
  // Codex prints its status line on stderr in some versions; accept either stream.
  return s.parseStatus(r.status, r.stdout?.trim() ? r.stdout : r.stderr ?? "");
}

/** Sign the profile in (or change its account) with the CLI's own login. */
export async function loginProfile(providerId: string, name: string): Promise<number> {
  const s = spec(providerId);
  prepareProfile(providerId, name);
  return runChild(s.command, s.loginArgs, profileEnv(providerId, name));
}

/** Launch the CLI inside the profile, signing in first only if it has no login. */
export async function runProfile(providerId: string, name: string, args: string[]): Promise<number> {
  const s = spec(providerId);
  prepareProfile(providerId, name);
  if (!profileStatus(providerId, name).loggedIn) {
    console.error(`Profile "${name}" is not signed in yet — starting \`${s.command} ${s.loginArgs.join(" ")}\`.`);
    const code = await loginProfile(providerId, name);
    if (code !== 0) return code;
  }
  return runChild(s.command, args, profileEnv(providerId, name));
}
