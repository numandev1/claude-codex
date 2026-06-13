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
  constructor(readonly provider: Provider) {
    this.store = new Store(provider.stateDir);
  }

  loadRegistry(): Registry {
    return this.store.loadRegistry();
  }

  private matchActive(registry: Registry, liveAuth: SessionAuth | null): string | null {
    const fp = this.provider.fingerprint(liveAuth);
    if (!fp) return null;
    const matches = Object.entries(registry.sessions).filter(
      ([, meta]) => meta.fingerprint && meta.fingerprint === fp,
    );
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0][0];
    // Fingerprint tie (e.g. Claude accounts in the same org share an org
    // fingerprint): disambiguate by email, then keep the current active
    // session rather than flipping to whichever happens to be listed first.
    const liveEmail = this.provider.describeAuth(liveAuth).email;
    if (liveEmail) {
      const byEmail = matches.find(([, meta]) => meta.email === liveEmail);
      if (byEmail) return byEmail[0];
    }
    if (registry.active && matches.some(([name]) => name === registry.active)) {
      return registry.active;
    }
    return matches[0][0];
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
      }
    }
    this.provider.writeLiveAuth(this.store.readSnapshot(name));
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

  importBlob(name: string, blob: string, { overwrite = false } = {}): void {
    const { providerId, auth } = this.decodeBlob(blob);
    if (providerId !== this.provider.id) {
      throw new Error(`That token is for "${providerId}", not "${this.provider.id}". Switch provider first.`);
    }
    this.persistSession(name, auth, { overwrite, setActive: false });
  }

  // ---- login ----
  get supportsLogin(): boolean {
    return this.provider.supportsLogin && !!this.provider.runLoginFlow;
  }

  async getSession(opts: LoginOptions): Promise<LoginResult & { name: string }> {
    if (!this.provider.runLoginFlow) throw new Error(`${this.provider.label} login is not supported.`);
    const result = await this.provider.runLoginFlow(opts);
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
