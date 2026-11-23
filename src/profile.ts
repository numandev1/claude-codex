import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CODEX_HOME, providerStateDir } from "./paths.js";
import { describeAuth } from "./auth.js";

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
  /**
   * How to stop the CLI from setting the terminal title itself, so the account
   * title set by `run` stays visible for the whole session.
   */
  keepTitle: { args?: string[]; env?: Record<string, string> };
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
    keepTitle: { env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" } },
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
    keepTitle: { args: ["-c", "tui.terminal_title=[]"] },
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

/** Read a JSON file, or null if it is missing or unreadable. */
function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The account email a profile is signed in as, for display only. Null when it
 * cannot be told locally (not signed in yet, or the login lives in an OS
 * credential store) — callers fall back to the profile name.
 */
export function profileEmail(providerId: string, name: string): string | null {
  const dir = profileDir(providerId, name);
  if (providerId === "claude") {
    // Claude Code records the signed-in account in the profile's own config.
    return readJson(path.join(dir, ".claude.json"))?.oauthAccount?.emailAddress ?? null;
  }
  if (providerId === "codex") return describeAuth(readJson(path.join(dir, "auth.json"))).email;
  return null;
}

/**
 * Make it obvious which account a terminal is on: a banner line that stays in
 * the scrollback above the CLI, plus the terminal tab/window title. Only when
 * attached to a terminal, so piped and scripted runs stay clean.
 */
function announce(providerId: string, name: string): () => void {
  if (!process.stdout.isTTY) return () => {};
  const email = profileEmail(providerId, name);
  const who = email && email !== name ? `${name}  ·  ${email}` : name;
  const label = `${providerId}  ·  isolated profile: ${who}`;
  process.stdout.write(`\x1b[1;30;46m ${label} \x1b[0m\n`);
  process.stdout.write(`\x1b]0;${email || name} — ${providerId}\x07`);
  const startedAt = Date.now();
  return () => {
    process.stdout.write("\x1b]0;\x07");
    process.stdout.write(`\x1b[2m${label} — ended\x1b[0m\n`);
    // The CLI's own "resume with: claude --resume <id>" hint looks in the
    // default home, where this profile's conversations do not exist.
    const id = lastClaudeSession(providerId, name, startedAt);
    if (id) process.stdout.write(`\x1b[2mResume in this profile:\x1b[0m ccx claude run ${name} --resume ${id}\n`);
  };
}

/**
 * The Claude conversation this profile last wrote for the current directory
 * since `since`, or null (other providers, or nothing was written).
 */
function lastClaudeSession(providerId: string, name: string, since: number): string | null {
  if (providerId !== "claude") return null;
  // Claude Code names a project's folder after its path, non-alphanumerics as "-".
  const dir = path.join(profileDir(providerId, name), "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  try {
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((e) => e.at >= since)
      .sort((x, y) => y.at - x.at)[0];
    return newest ? newest.f.slice(0, -".jsonl".length) : null;
  } catch {
    return null;
  }
}

/** Sign the profile in (or change its account) with the CLI's own login. */
export async function loginProfile(providerId: string, name: string): Promise<number> {
  const s = spec(providerId);
  prepareProfile(providerId, name);
  return runChild(s.command, s.loginArgs, profileEnv(providerId, name));
}

/**
 * `--resume <id>` for a conversation that lives in another profile (or the
 * default home): copy it into this profile so it can be continued on this
 * account, e.g. after the other one hit its limit. The original stays put.
 */
function adoptClaudeSession(providerId: string, name: string, args: string[]): { id: string; from: string } | null {
  if (providerId !== "claude") return null;
  const flag = args.findIndex((a) => a === "--resume" || a === "-r");
  const id = flag >= 0 ? args[flag + 1] : args.find((a) => a.startsWith("--resume="))?.slice("--resume=".length);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;

  const own = path.join(profileDir(providerId, name), "projects");
  const find = (projects: string): string | null => {
    try {
      for (const project of fs.readdirSync(projects)) {
        if (fs.existsSync(path.join(projects, project, `${id}.jsonl`))) return path.join(projects, project);
      }
    } catch {
      // No conversations there.
    }
    return null;
  };
  if (find(own)) return null;

  const sources = [
    ...listProfiles(providerId)
      .filter((other) => other !== name)
      .map((other) => ({ from: `profile "${other}"`, projects: path.join(profileDir(providerId, other), "projects") })),
    { from: "the default home", projects: path.join(spec(providerId).home, "projects") },
  ];
  for (const source of sources) {
    const found = find(source.projects);
    if (!found) continue;
    const target = path.join(own, path.basename(found));
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(found, `${id}.jsonl`), path.join(target, `${id}.jsonl`));
    // Subagent transcripts and tool results sit in a folder named after the conversation.
    const extras = path.join(found, id);
    if (fs.existsSync(extras)) fs.cpSync(extras, path.join(target, id), { recursive: true });
    return { id, from: source.from };
  }
  return null;
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
  const adopted = adoptClaudeSession(providerId, name, args);
  if (adopted) console.error(`Copied conversation ${adopted.id} from ${adopted.from} into profile "${name}".`);
  const done = announce(providerId, name);
  try {
    // Only in a terminal: scripted runs get the CLI exactly as invoked.
    const keep = process.stdout.isTTY ? s.keepTitle : {};
    return await runChild(s.command, [...(keep.args ?? []), ...args], {
      ...keep.env,
      ...profileEnv(providerId, name),
    });
  } finally {
    done();
  }
}
