import path from "node:path";
import { spawn } from "node:child_process";
import { Store } from "./store.js";
import { pickBest, soonestReset, nowSec, type SoonestReset } from "./rateLimits.js";
import type { Provider, LoginOptions, LoginResult } from "./providers/provider.js";
import type { Registry, SessionAuth, SessionMeta } from "./types.js";

const BLOB_PREFIX = "claudecodex:v1:";

export interface BestResult {
  switched: boolean;
  name?: string;
  primaryFree?: number;
  secondaryFree?: number;
  alreadyActive?: boolean;
  allExhausted?: boolean;
  soonest?: SoonestReset | null;
}

export interface RefreshOutcome {
  name: string;
  ok: boolean;
  needsReauth?: boolean;
  error?: string;
}

export interface SyncResult {
  registry: Registry;
  activeName: string | null;
  unsaved: boolean;
}

/** All session operations for one provider, bound to its store + live login. */
export class Engine {
  readonly store: Store;
  /** Set by the TUI when the user presses [i]; cli.ts runs it after Ink exits. */
  pendingIncognito: { name: string; args: string[] } | null = null;
  constructor(readonly provider: Provider) {
    this.store = new Store(provider.stateDir);
  }

  loadRegistry(): Registry {
    return this.store.loadRegistry();
  }

  /** Find the name of an existing session whose stored email matches the given address. */
  findExistingByEmail(email: string): string | null {
    const registry = this.store.loadRegistry();
    const match = Object.entries(registry.sessions).find(([, meta]) => meta.email === email);
    return match ? match[0] : null;
  }

  /** Keep registry metadata in sync after a snapshot write that may have rotated tokens. */
  private resyncMeta(name: string, auth: SessionAuth): void {
    const registry = this.store.loadRegistry();
    if (!registry.sessions[name]) return;
    const fp = this.provider.fingerprint(auth);
    if (fp != null) registry.sessions[name].fingerprint = fp;
    const d = this.provider.describeAuth(auth);
    if (d.email) registry.sessions[name].email = d.email;
    if (d.plan) registry.sessions[name].plan = d.plan;
    if (d.accountId) registry.sessions[name].accountId = d.accountId;
    this.store.saveRegistry(registry);
  }

  private matchActive(registry: Registry, liveAuth: SessionAuth | null): string | null {
    const fp = this.provider.fingerprint(liveAuth);
    const liveEmail = this.provider.describeAuth(liveAuth).email;

    if (fp) {
      const matches = Object.entries(registry.sessions).filter(
        ([, meta]) => meta.fingerprint && meta.fingerprint === fp,
      );
      if (matches.length === 1) return matches[0][0];
      if (matches.length > 1) {
        // Fingerprint tie (e.g. Claude accounts in the same org share an org
        // fingerprint): disambiguate by email, then keep the current active.
        if (liveEmail) {
          const byEmail = matches.find(([, meta]) => meta.email === liveEmail);
          if (byEmail) return byEmail[0];
        }
        if (registry.active && matches.some(([name]) => name === registry.active)) {
          return registry.active;
        }
        return matches[0][0];
      }
    }

    // No fingerprint match → fall back to email comparison.
    if (liveEmail) {
      const byEmail = Object.entries(registry.sessions).find(([, meta]) => meta.email === liveEmail);
      if (byEmail) return byEmail[0];
    }

    return null;
  }

  /** Reconcile registry with disk: which saved session is the live login? */
  syncFromDisk(): SyncResult {
    const registry = this.store.loadRegistry();
    const live = this.provider.readLiveAuth();
    let activeName: string | null = null;
    let unsaved = false;
    if (live) {
      activeName = this.matchActive(registry, live);
      registry.active = activeName;
      unsaved = activeName === null;
      // Repair a stale fingerprint so subsequent opens don't lose the match.
      if (activeName) {
        const liveFp = this.provider.fingerprint(live);
        if (liveFp != null && registry.sessions[activeName]?.fingerprint !== liveFp) {
          registry.sessions[activeName].fingerprint = liveFp;
        }
      }
    } else {
      registry.active = null;
    }
    this.store.saveRegistry(registry);
    return { registry, activeName, unsaved };
  }

  private describeMeta(auth: SessionAuth, prev?: SessionMeta): Omit<SessionMeta, "rateLimits"> {
    const d = this.provider.describeAuth(auth);
    return {
      label: d.email || prev?.label || "",
      email: d.email,
      plan: d.plan,
      accountId: d.accountId,
      fingerprint: this.provider.fingerprint(auth),
      savedAt: prev?.savedAt ?? Date.now(),
      lastUsedAt: prev?.lastUsedAt ?? Date.now(),
    };
  }

  /** Persist an auth blob as a named session. */
  persistSession(
    name: string,
    auth: SessionAuth,
    { overwrite = false, setActive = false } = {},
  ): void {
    const registry = this.store.loadRegistry();
    if (this.store.snapshotExists(name) && !overwrite) {
      throw new Error(`Session "${name}" already exists. Choose another name or overwrite.`);
    }
    const prev = registry.sessions[name];
    this.store.writeSnapshot(name, auth);
    const base = this.describeMeta(auth, prev);
    registry.sessions[name] = { ...base, label: base.label || name, rateLimits: prev?.rateLimits ?? null };
    if (setActive) registry.active = name;
    this.store.saveRegistry(registry);
  }

  /** Save the current live login as a named session. */
  saveCurrent(name: string, { overwrite = false } = {}): void {
    const live = this.provider.readLiveAuth();
    if (!live) throw new Error(`Not logged in to ${this.provider.label}. Log in first, then save.`);
    this.persistSession(name, live, { overwrite, setActive: true });
  }

  /** Switch the live login to a saved session (re-syncs the outgoing one first). */
  useSession(name: string): void {
    const registry = this.store.loadRegistry();
    if (!registry.sessions[name] || !this.store.snapshotExists(name)) {
      throw new Error(`No saved session named "${name}".`);
    }
    const live = this.provider.readLiveAuth();
    const outgoing = registry.active;
    if (live && outgoing && outgoing !== name && registry.sessions[outgoing]) {
      // Preserve rotated tokens — but only when the live credentials verifiably
      // belong to the outgoing session. If the registry's `active` is stale or
      // ambiguous (e.g. org-mates sharing a fingerprint), writing the live blob
      // would overwrite that session's account with a different one.
      const meta = registry.sessions[outgoing];
      const fp = this.provider.fingerprint(live);
      const liveEmail = this.provider.describeAuth(live).email;
      const fpMatches = !!fp && fp === meta.fingerprint;
      const emailMatches = !liveEmail || !meta.email || liveEmail === meta.email;
      if (fpMatches && emailMatches) {
        this.store.writeSnapshot(outgoing, live);
        // Update outgoing fingerprint inline (single registry save below).
        if (fp != null) registry.sessions[outgoing].fingerprint = fp;
      }
    }
    const incoming = this.store.readSnapshot(name);
    this.provider.writeLiveAuth(incoming);
    // Keep stored fingerprint in sync with what was just written to the keychain
    // so the next syncFromDisk can identify this session even after token rotation.
    const incomingFp = this.provider.fingerprint(incoming);
    if (incomingFp != null) registry.sessions[name].fingerprint = incomingFp;
    registry.active = name;
    registry.sessions[name].lastUsedAt = Date.now();
    this.store.saveRegistry(registry);
  }

  switchToBest(): BestResult {
    const registry = this.store.loadRegistry();
    const sessions = Object.entries(registry.sessions).map(([name, meta]) => ({ name, meta }));
    if (sessions.length === 0) throw new Error("No saved sessions yet.");
    const now = nowSec();
    const best = pickBest(sessions, now);
    if (!best) return { switched: false, allExhausted: true, soonest: soonestReset(sessions, now) };
    if (registry.active === best.name) {
      return {
        switched: false,
        alreadyActive: true,
        name: best.name,
        primaryFree: best.primaryFree,
        secondaryFree: best.secondaryFree,
      };
    }
    this.useSession(best.name);
    return {
      switched: true,
      name: best.name,
      primaryFree: best.primaryFree,
      secondaryFree: best.secondaryFree,
    };
  }

  rename(oldName: string, newName: string): void {
    const registry = this.store.loadRegistry();
    if (!registry.sessions[oldName]) throw new Error(`No session named "${oldName}".`);
    if (registry.sessions[newName]) throw new Error(`Session "${newName}" already exists.`);
    this.store.writeSnapshot(newName, this.store.readSnapshot(oldName));
    this.store.deleteSnapshot(oldName);
    registry.sessions[newName] = registry.sessions[oldName];
    delete registry.sessions[oldName];
    if (registry.active === oldName) registry.active = newName;
    this.store.saveRegistry(registry);
  }

  remove(name: string): void {
    const registry = this.store.loadRegistry();
    if (!registry.sessions[name]) throw new Error(`No session named "${name}".`);
    this.store.deleteSnapshot(name);
    delete registry.sessions[name];
    if (registry.active === name) registry.active = null;
    this.store.saveRegistry(registry);
  }

  // ---- live usage ----
  async refreshSession(name: string): Promise<RefreshOutcome> {
    let registry = this.store.loadRegistry();
    if (!registry.sessions[name] || !this.store.snapshotExists(name)) {
      return { name, ok: false, error: "no such session" };
    }
    const auth = this.store.readSnapshot(name);
    const result = await this.provider.fetchUsage(auth);

    if (result.refreshedAuth) {
      this.store.writeSnapshot(name, result.refreshedAuth);
      this.resyncMeta(name, result.refreshedAuth);
      registry = this.store.loadRegistry();
      if (registry.active === name) this.provider.writeLiveAuth(result.refreshedAuth);
    }
    registry = this.store.loadRegistry();
    if (!registry.sessions[name]) return { name, ok: false, error: "session removed" };
    if (result.rateLimits) {
      registry.sessions[name].rateLimits = { ...result.rateLimits, capturedAt: Date.now(), source: "live" };
      this.store.saveRegistry(registry);
      return { name, ok: true };
    }
    this.store.saveRegistry(registry);
    return { name, ok: false, needsReauth: result.needsReauth, error: result.error };
  }

  async refreshAll(): Promise<RefreshOutcome[]> {
    // Sequential on purpose: each refreshSession does a load-mutate-save on
    // the registry, so concurrent refreshes clobber each other's writes
    // (lost rateLimits, and worse — a stale `active` re-written over a switch
    // the user just made).
    const names = Object.keys(this.store.loadRegistry().sessions);
    const outcomes: RefreshOutcome[] = [];
    for (const n of names) outcomes.push(await this.refreshSession(n));
    return outcomes;
  }

  // ---- incognito (isolated profile) ----
  get supportsIncognito(): boolean {
    return !!this.provider.incognito;
  }

  incognitoProfileDir(name: string): string {
    return path.join(this.provider.stateDir, "profiles", name);
  }

  /**
   * Run the provider's CLI on a saved session inside an isolated profile dir.
   * The global login (and any running sessions using it) is never touched.
   * Returns the CLI's exit code; rotated tokens are synced back afterwards.
   */
  async runIncognito(name: string, args: string[]): Promise<number> {
    const iso = this.provider.incognito;
    if (!iso) throw new Error(`${this.provider.label} does not support incognito sessions.`);
    if (!this.store.loadRegistry().sessions[name] || !this.store.snapshotExists(name)) {
      throw new Error(`No saved session named "${name}".`);
    }

    // Freshen tokens first — a stale access token inside the profile fails
    // with a 401 instead of refreshing reliably.
    const outcome = await this.refreshSession(name);
    if (outcome.needsReauth) {
      throw new Error(`Session "${name}" needs re-auth — run \`get-session\` or \`remote\` again.`);
    }

    const auth = this.store.readSnapshot(name);
    const dir = this.incognitoProfileDir(name);
    iso.seed(dir, auth);

    // Snapshot the global live auth so we can restore it after the child exits.
    // Some CLIs (Claude Code) write back refreshed tokens to the global credential
    // store even when CLAUDE_CONFIG_DIR / CODEX_HOME is set, which corrupts the
    // active-session fingerprint for every other session.
    const globalAuthBackup = this.provider.readLiveAuth();

    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(iso.command, args, {
        stdio: "inherit",
        env: { ...process.env, ...iso.buildEnv(dir) },
      });
      // Ctrl+C goes to the foreground child via the shared TTY; the parent
      // must survive it to sync tokens back after the child exits.
      const onSignal = () => {};
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      const cleanup = () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      };
      child.on("error", (err) => {
        cleanup();
        reject(new Error(`Could not start \`${iso.command}\`: ${err.message}`));
      });
      child.on("exit", (exitCode) => {
        cleanup();
        resolve(exitCode ?? 0);
      });
    });

    // Restore the global credential store in case the child process leaked
    // its refreshed tokens into it (Claude Code does this even with CLAUDE_CONFIG_DIR).
    if (globalAuthBackup) this.provider.writeLiveAuth(globalAuthBackup);

    const updated = iso.collect(dir, auth);
    if (updated) { this.store.writeSnapshot(name, updated); this.resyncMeta(name, updated); }
    return code;
  }

  // ---- sharing ----
  exportBlob(name: string): string {
    if (!this.store.snapshotExists(name)) throw new Error(`No saved session named "${name}".`);
    const auth = this.store.readSnapshot(name);
    return BLOB_PREFIX + Buffer.from(JSON.stringify({ p: this.provider.id, a: auth }), "utf8").toString("base64");
  }

  decodeBlob(blob: string): { providerId: string; auth: SessionAuth } {
    const trimmed = blob.trim();
    if (!trimmed) throw new Error("Empty token.");
    const payload = trimmed.startsWith(BLOB_PREFIX) ? trimmed.slice(BLOB_PREFIX.length) : trimmed;

    // Accept: our wrapped blob (base64 JSON), or a raw pasted JSON
    // (a Codex auth.json / Claude credentials object), in either order.
    let obj: any = null;
    const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
    if (trimmed.startsWith(BLOB_PREFIX)) {
      obj = tryParse(Buffer.from(payload, "base64").toString("utf8"));
    } else {
      obj = tryParse(trimmed) ?? tryParse(Buffer.from(payload, "base64").toString("utf8"));
    }
    if (!obj || typeof obj !== "object") {
      throw new Error("Could not read that token — expected a claudecodex token, an auth.json, or credentials JSON.");
    }

    // Wrapped blob: { p: providerId, a: auth }
    if (obj.a && obj.p) return { providerId: obj.p, auth: obj.a as SessionAuth };
    // Codex auth.json shape, or a full Claude credentials blob.
    if (obj.tokens || obj.claudeAiOauth) return { providerId: this.provider.id, auth: obj };
    // A bare Claude OAuth object → wrap it into a credentials blob.
    if (obj.accessToken && obj.refreshToken) {
      return { providerId: "claude", auth: { claudeAiOauth: obj } };
    }
    throw new Error("Token has no recognizable credentials (no tokens / claudeAiOauth).");
  }

  /** Returns the session name actually used (may differ from `name` if merged by email). */
  importBlob(name: string, blob: string, { overwrite = false } = {}): string {
    const { providerId, auth } = this.decodeBlob(blob);
    if (providerId !== this.provider.id) {
      throw new Error(`That token is for "${providerId}", not "${this.provider.id}". Switch provider first.`);
    }
    const d = this.provider.describeAuth(auth);
    if (d.email) {
      const existing = this.findExistingByEmail(d.email);
      if (existing && existing !== name) {
        this.persistSession(existing, auth, { overwrite: true, setActive: false });
        return existing;
      }
    }
    this.persistSession(name, auth, { overwrite, setActive: false });
    return name;
  }

  // ---- login ----
  get supportsLogin(): boolean {
    return this.provider.supportsLogin && !!this.provider.runLoginFlow;
  }

  async getSession(opts: LoginOptions): Promise<LoginResult & { name: string }> {
    if (!this.provider.runLoginFlow) throw new Error(`${this.provider.label} login is not supported.`);
    const result = await this.provider.runLoginFlow(opts);
    // If this email already has a saved session, update its tokens in-place.
    if (result.email) {
      const existing = this.findExistingByEmail(result.email);
      if (existing) {
        this.persistSession(existing, result.auth, { overwrite: true, setActive: false });
        return { ...result, name: existing };
      }
    }
    const suggested =
      (result.email ? result.email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "") : "") ||
      `${this.provider.id}-${this.provider.fingerprint(result.auth)?.slice(-6) ?? "acct"}`;
    this.persistSession(suggested, result.auth, {
      overwrite: !!this.store.loadRegistry().sessions[suggested],
      setActive: false,
    });
    return { ...result, name: suggested };
  }
}
