import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { providerStateDir } from "../paths.js";
import { atomicWrite } from "../fsutil.js";
import { openBrowser } from "../login.js";
import type { AuthDescription, RateLimits, SessionAuth } from "../types.js";
import type { LiveUsageResult, LoginOptions, LoginResult, Provider } from "./provider.js";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";
const BETA = "oauth-2025-04-20";

interface ClaudeOAuth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}
interface ClaudeBlob {
  claudeAiOauth?: ClaudeOAuth;
  organizationUuid?: string;
  mcpOAuth?: unknown;
  [k: string]: unknown;
}

/**
 * Where Claude Code keeps the live login, per platform.
 *
 * macOS stores it in the login keychain. Linux and Windows have no keychain to
 * talk to — Claude Code writes `~/.claude/.credentials.json` instead, the same
 * shape the `incognito` seed below already produces for CLAUDE_CONFIG_DIR.
 * `security` is a macOS binary, so calling it elsewhere throws
 * `spawnSync security ENOENT`, which took out every command that writes the live
 * login (`use`, `best`, `save` round-trips) on non-Darwin hosts.
 */
const CLAUDE_CREDENTIALS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
const HAS_KEYCHAIN = process.platform === "darwin";

function keychainAccount(): string {
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], {
      encoding: "utf8",
    });
    const m = out.match(/"acct"<blob>="([^"]*)"/);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return os.userInfo().username;
}

function readKeychain(): ClaudeBlob | null {
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
    });
    return JSON.parse(raw.trim()) as ClaudeBlob;
  } catch {
    return null;
  }
}

function writeKeychain(blob: ClaudeBlob): void {
  const acct = keychainAccount();
  const json = JSON.stringify(blob);
  // -U updates the item if it already exists.
  execFileSync("security", [
    "add-generic-password",
    "-U",
    "-a",
    acct,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    json,
  ]);
}

function readCredentialsFile(): ClaudeBlob | null {
  try {
    const raw = fs.readFileSync(CLAUDE_CREDENTIALS_FILE, "utf8");
    return JSON.parse(raw) as ClaudeBlob;
  } catch {
    return null;
  }
}

function writeCredentialsFile(blob: ClaudeBlob): void {
  atomicWrite(CLAUDE_CREDENTIALS_FILE, JSON.stringify(blob, null, 2) + "\n", { secret: true });
}

/**
 * Who Claude Code itself says is signed in, from its own config file.
 *
 * The credentials blob carries no email of its own. This manager adds one when
 * it writes a session, and Claude Code preserves that extra key when the user
 * later signs in as someone else — leaving the blob labelled with the previous
 * account. Claude Code's config is authoritative whenever it describes the same
 * account as the credentials (matched by account id).
 */
function liveAccountEmail(blob: ClaudeBlob): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const acct = cfg?.oauthAccount;
    const blobAccount = (blob.claudeAiOauth as any)?.accountUuid;
    if (acct?.emailAddress && blobAccount && acct.accountUuid === blobAccount) {
      return acct.emailAddress as string;
    }
  } catch {
    /* no config, or unreadable — fall back to the blob */
  }
  return null;
}

/** Read the live Claude login from wherever this platform keeps it. */
function readLiveClaudeAuth(): ClaudeBlob | null {
  let blob: ClaudeBlob | null = null;
  if (HAS_KEYCHAIN) blob = readKeychain();
  // Fall through: a Linux-provisioned home synced to a Mac, or a Claude Code
  // build that wrote the file rather than the keychain, still resolves.
  if (!blob) blob = readCredentialsFile();
  if (!blob) return null;
  const email = liveAccountEmail(blob);
  return email ? { ...blob, email } : blob;
}

/** Replace the live Claude login. */
function writeLiveClaudeAuth(blob: ClaudeBlob): void {
  if (HAS_KEYCHAIN) {
    try {
      writeKeychain(blob);
      return;
    } catch {
      // Keychain can refuse in CI, over SSH, or when the login keychain is
      // locked. Writing the file is better than losing the session entirely.
    }
  }
  writeCredentialsFile(blob);
}

function isoToEpochSec(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

function normalizeUsage(json: any, plan: string | null): RateLimits | null {
  if (!json) return null;
  const win = (w: any, minutes: number): RateLimits["primary"] =>
    w && typeof w.utilization === "number"
      ? { used_percent: w.utilization, window_minutes: minutes, resets_at: isoToEpochSec(w.resets_at) }
      : null;
  return {
    primary: win(json.five_hour, 300),
    secondary: win(json.seven_day, 10080),
    plan_type: plan,
    rate_limit_reached_type: null,
  };
}

async function fetchJson(url: string, token: string): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": BETA,
        Accept: "application/json",
        "User-Agent": "claudecodex",
      },
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    clearTimeout(id);
  }
}

async function refreshToken(blob: ClaudeBlob): Promise<ClaudeBlob | null> {
  const rt = blob.claudeAiOauth?.refreshToken;
  if (!rt) return null;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: rt, client_id: CLIENT_ID }),
    });
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    if (!data?.access_token) return null;
    return {
      ...blob,
      claudeAiOauth: {
        ...blob.claudeAiOauth,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? rt,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : blob.claudeAiOauth?.expiresAt,
      },
    };
  } catch {
    return null;
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export const claudeProvider: Provider = {
  id: "claude",
  label: "Claude Code",
  stateDir: providerStateDir("claude"),
  supportsLogin: true,

  isLoggedIn(): boolean {
    const b = readLiveClaudeAuth();
    return !!b?.claudeAiOauth?.accessToken;
  },

  readLiveAuth: () => readLiveClaudeAuth() as SessionAuth | null,
  writeLiveAuth: (auth: SessionAuth) => writeLiveClaudeAuth(auth as ClaudeBlob),

  describeAuth(auth: SessionAuth | null): AuthDescription {
    const b = auth as ClaudeBlob | null;
    return {
      email: (b?.email as string) || null, // populated at login time if known
      plan: b?.claudeAiOauth?.subscriptionType || null,
      accountId: b?.organizationUuid || null,
    };
  },

  fingerprint(auth: SessionAuth | null): string | null {
    const b = auth as ClaudeBlob | null;
    if (!b?.claudeAiOauth) return null;
    // Per-account id when the login carries one; the org id is shared by
    // everyone in the same organization, so it is only a fallback.
    const accountUuid = (b.claudeAiOauth as any).accountUuid;
    if (accountUuid) return `acct:${accountUuid}`;
    if (b.organizationUuid) return `org:${b.organizationUuid}`;
    const rt = b.claudeAiOauth.refreshToken;
    return rt ? "rt:" + crypto.createHash("sha256").update(rt).digest("hex").slice(0, 16) : null;
  },

  async fetchUsage(auth: SessionAuth): Promise<LiveUsageResult> {
    let blob = auth as ClaudeBlob;
    const token = blob.claudeAiOauth?.accessToken;
    const plan = blob.claudeAiOauth?.subscriptionType || null;
    if (!token) return { rateLimits: null, needsReauth: true };

    let { status, body } = await fetchJson(USAGE_URL, token).catch(() => ({ status: 0, body: null }));
    if (status === 401 || status === 403) {
      const refreshed = await refreshToken(blob);
      if (!refreshed) return { rateLimits: null, needsReauth: true };
      blob = refreshed;
      const retry = await fetchJson(USAGE_URL, blob.claudeAiOauth!.accessToken!).catch(() => ({
        status: 0,
        body: null,
      }));
      if (retry.status !== 200) return { rateLimits: null, refreshedAuth: blob, needsReauth: true };
      return { rateLimits: normalizeUsage(retry.body, plan), refreshedAuth: blob };
    }
    if (status !== 200) {
      // Usage API may rate-limit (429) before checking auth. If the local token
      // is already past its expiresAt, refresh proactively so incognito seeding
      // and future requests don't use a stale access token.
      const exp = blob.claudeAiOauth?.expiresAt;
      if (exp && exp < Date.now()) {
        const refreshed = await refreshToken(blob);
        if (refreshed) return { rateLimits: null, refreshedAuth: refreshed };
        // Token expired and refresh token rejected → session is dead
        return { rateLimits: null, needsReauth: true };
      }
      return { rateLimits: null, error: `HTTP ${status}` };
    }
    return { rateLimits: normalizeUsage(body, plan) };
  },

  async runLoginFlow(opts: LoginOptions): Promise<LoginResult> {
    if (!opts.promptCode) {
      throw new Error("Claude login needs an interactive code prompt (run it from a terminal).");
    }
    const verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(32));
    const url =
      `${AUTHORIZE_URL}?` +
      new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();

    opts.onUrl?.(url);
    openBrowser(url);

    const pasted = (await opts.promptCode(
      "After approving, copy the code shown and paste it here:",
    )).trim();
    // Claude returns "code#state"; accept either form.
    const code = pasted.split("#")[0].split("&")[0].trim();

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        state,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Claude token exchange failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
    }
    const data: any = await res.json();
    if (!data?.access_token) throw new Error("Claude token response missing access_token.");

    const blob: ClaudeBlob = {
      claudeAiOauth: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
        scopes: typeof data.scope === "string" ? data.scope.split(" ") : undefined,
        subscriptionType: data.subscription_type ?? data.account?.subscription_type ?? undefined,
      },
    };

    // Best-effort enrichment: email + organization uuid (needed to identify the account).
    let email: string | null = null;
    try {
      const prof = await fetchJson(PROFILE_URL, data.access_token);
      if (prof.status === 200 && prof.body) {
        email = prof.body.account?.email || prof.body.email || null;
        const org = prof.body.organization?.uuid || prof.body.organization_uuid;
        if (org) blob.organizationUuid = org;
        const sub = prof.body.account?.subscription_type || prof.body.subscription_type;
        if (sub && blob.claudeAiOauth) blob.claudeAiOauth.subscriptionType = sub;
      }
    } catch {
      /* enrichment best-effort */
    }
    if (email) (blob as any).email = email;

    return { auth: blob as SessionAuth, email, plan: blob.claudeAiOauth?.subscriptionType || null };
  },

  // Claude Code honours CLAUDE_CONFIG_DIR: with it set, credentials live in
  // <dir>/.credentials.json (no global keychain entry involved), and all
  // state (settings, project trust, history) stays inside the profile.
  incognito: {
    command: "claude",
    buildEnv: (profileDir: string) => ({ CLAUDE_CONFIG_DIR: profileDir }),
    seed(profileDir: string, auth: SessionAuth): void {
      const blob = auth as ClaudeBlob;
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(profileDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: blob.claudeAiOauth }),
        { mode: 0o600 },
      );
    },
    collect(profileDir: string, seeded: SessionAuth): SessionAuth | null {
      try {
        const cred = JSON.parse(
          fs.readFileSync(path.join(profileDir, ".credentials.json"), "utf8"),
        );
        if (!cred?.claudeAiOauth?.accessToken) return null;
        // Keep identity fields (email, organizationUuid) from the snapshot;
        // only the OAuth tokens rotate inside the profile.
        return { ...(seeded as ClaudeBlob), claudeAiOauth: cred.claudeAiOauth } as SessionAuth;
      } catch {
        return null;
      }
    },
  },
};
