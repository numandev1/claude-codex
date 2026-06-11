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
    for (const [name, meta] of Object.entries(registry.sessions)) {
      if (meta.fingerprint && meta.fingerprint === fp) return name;
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
    if (live && registry.active && registry.active !== name && registry.sessions[registry.active]) {
      this.store.writeSnapshot(registry.active, live); // preserve rotated tokens
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
    const names = Object.keys(this.store.loadRegistry().sessions);
    return Promise.all(names.map((n) => this.refreshSession(n)));
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
