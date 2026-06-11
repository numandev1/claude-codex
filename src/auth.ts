import fs from "node:fs";
import crypto from "node:crypto";
import { CODEX_LIVE_AUTH } from "./paths.js";
import { atomicWrite } from "./fsutil.js";
import type { AuthJson, AuthDescription } from "./types.js";

/** Read the codex CLI's live auth.json. Returns null if not logged in. */
export function readLiveAuth(): AuthJson | null {
  try {
    const raw = fs.readFileSync(CODEX_LIVE_AUTH, "utf8");
    return JSON.parse(raw) as AuthJson;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new Error(`Could not read ${CODEX_LIVE_AUTH}: ${e.message}`);
  }
}

/** Overwrite the live auth.json (token-bearing → 0600, atomic). */
export function writeLiveAuth(authObj: AuthJson): void {
  atomicWrite(CODEX_LIVE_AUTH, JSON.stringify(authObj, null, 2) + "\n", {
    secret: true,
  });
}

export function isLoggedIn(): boolean {
  const auth = readLiveAuth();
  return !!(auth && auth.tokens && (auth.tokens.id_token || auth.tokens.access_token));
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Decode the id_token JWT payload (no verification — we only read claims from
 * a token codex already obtained). Returns null on any failure.
 */
export function decodeJwtPayload(jwt: string | undefined): Record<string, any> | null {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as Record<string, any>;
  } catch {
    return null;
  }
}

/**
 * Pull a friendly label from an auth.json: email + ChatGPT plan + account id.
 * Codex stores account info both as top-level claims and under the
 * "https://api.openai.com/auth" namespaced claim, so we check both.
 */
export function describeAuth(authObj: AuthJson | null): AuthDescription {
  const out: AuthDescription = { email: null, plan: null, accountId: null };
  if (!authObj) return out;

  out.accountId = authObj.tokens?.account_id ?? null;

  const claims = decodeJwtPayload(authObj.tokens?.id_token);
  if (claims) {
    out.email = claims.email ?? null;
    const ns = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, any>;
    out.plan = ns.chatgpt_plan_type ?? claims.chatgpt_plan_type ?? ns.plan_type ?? null;
    out.accountId =
      out.accountId ?? ns.chatgpt_account_id ?? claims.chatgpt_account_id ?? null;
  }
  return out;
}

/**
 * Stable identifier for "which account is this auth.json". Prefer the codex
 * account_id; fall back to a hash of the refresh token so two different logins
 * never collide.
 */
export function fingerprint(authObj: AuthJson | null): string | null {
  if (!authObj || !authObj.tokens) return null;
  const accountId = authObj.tokens.account_id;
  if (accountId) return `acct:${accountId}`;
  const claims = decodeJwtPayload(authObj.tokens.id_token);
  const nsAcct = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (nsAcct) return `acct:${nsAcct}`;
  const refresh = authObj.tokens.refresh_token;
  if (refresh) {
    return "rt:" + crypto.createHash("sha256").update(refresh).digest("hex").slice(0, 16);
  }
  return null;
}
