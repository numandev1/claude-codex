import { decodeJwtPayload } from "./auth.js";
import type { AuthJson, RateLimits } from "./types.js";
import type { LiveUsageResult } from "./providers/provider.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

/** The OAuth client_id this login was issued for (read from the JWT claims). */
function clientIdFor(auth: AuthJson): string | null {
  const a = decodeJwtPayload(auth.tokens?.access_token);
  const i = decodeJwtPayload(auth.tokens?.id_token);
  return (a?.client_id as string) || (i?.client_id as string) || null;
}

/** Normalize the wham/usage response into our RateLimits shape. */
export function normalizeUsage(json: any): RateLimits | null {
  const rl = json?.rate_limit;
  if (!rl) return null;
  const win = (w: any) =>
    w
      ? {
          used_percent: typeof w.used_percent === "number" ? w.used_percent : 0,
          window_minutes:
            typeof w.limit_window_seconds === "number"
              ? Math.round(w.limit_window_seconds / 60)
              : 0,
          resets_at: typeof w.reset_at === "number" ? w.reset_at : 0,
        }
      : null;
  const reached = json?.rate_limit_reached_type;
  return {
    limit_id: json?.plan_type ?? undefined,
    primary: win(rl.primary_window),
    secondary: win(rl.secondary_window),
    credits: json?.credits ?? null,
    plan_type: json?.plan_type ?? null,
    rate_limit_reached_type:
      (reached && (reached.type as string)) || (rl.limit_reached ? "rate_limit_reached" : null),
  };
}

async function callUsage(accessToken: string, accountId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-multi-session",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return fetchWithTimeout(USAGE_URL, { method: "GET", headers });
}

/** Refresh the access token using the stored refresh token. Returns updated auth or null. */
async function refreshAuth(auth: AuthJson): Promise<AuthJson | null> {
  const refresh = auth.tokens?.refresh_token;
  const clientId = clientIdFor(auth);
  if (!refresh || !clientId) return null;
  let res: Response;
  try {
    res = await fetchWithTimeout(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refresh,
        scope: "openid profile email offline_access",
      }).toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data: any = await res.json().catch(() => null);
  if (!data?.access_token) return null;
  return {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: data.access_token,
      id_token: data.id_token ?? auth.tokens?.id_token,
      refresh_token: data.refresh_token ?? auth.tokens?.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };
}

/**
 * Fetch live usage for a given login. Tries the stored access token; on 401/403
 * it refreshes once and retries. Never throws — returns a result object.
 */
export async function fetchLiveUsage(auth: AuthJson): Promise<LiveUsageResult> {
  const accessToken = auth.tokens?.access_token;
  if (!accessToken) return { rateLimits: null, needsReauth: true };
  const accountId = auth.tokens?.account_id;

  let res: Response;
  try {
    res = await callUsage(accessToken, accountId);
  } catch (err) {
    return { rateLimits: null, error: (err as Error).message };
  }

  if (res.status === 401 || res.status === 403) {
    const refreshed = await refreshAuth(auth);
    if (!refreshed) return { rateLimits: null, needsReauth: true };
    try {
      res = await callUsage(refreshed.tokens!.access_token!, refreshed.tokens?.account_id);
    } catch (err) {
      return { rateLimits: null, refreshedAuth: refreshed, error: (err as Error).message };
    }
    if (!res.ok) return { rateLimits: null, refreshedAuth: refreshed, needsReauth: res.status === 401 };
    const json: any = await res.json().catch(() => null);
    return { rateLimits: normalizeUsage(json), refreshedAuth: refreshed };
  }

  if (!res.ok) return { rateLimits: null, error: `HTTP ${res.status}` };
  const json: any = await res.json().catch(() => null);
  return { rateLimits: normalizeUsage(json) };
}
