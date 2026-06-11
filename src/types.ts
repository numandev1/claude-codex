export interface RateWindow {
  used_percent: number;
  window_minutes: number;
  resets_at: number; // unix epoch seconds
}

export interface RateLimits {
  limit_id?: string;
  limit_name?: string | null;
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
  credits?: unknown;
  individual_limit?: unknown;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
  /** When this manager captured the snapshot (ms epoch). Added by us. */
  capturedAt?: number;
  /** Where the snapshot came from. Added by us. */
  source?: "live" | "rollout";
}

export interface AuthTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

export interface AuthJson {
  OPENAI_API_KEY?: string | null;
  tokens?: AuthTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

/** Provider-specific stored auth blob (codex auth.json or Claude keychain JSON). */
export type SessionAuth = Record<string, any>;

export interface SessionMeta {
  label: string;
  email: string | null;
  plan: string | null;
  accountId: string | null;
  fingerprint: string | null;
  savedAt: number;
  lastUsedAt: number;
  rateLimits: RateLimits | null;
}

export interface Registry {
  active: string | null;
  sessions: Record<string, SessionMeta>;
}

export interface AuthDescription {
  email: string | null;
  plan: string | null;
  accountId: string | null;
}
