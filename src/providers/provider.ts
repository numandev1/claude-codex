import type { AuthDescription, RateLimits, SessionAuth } from "../types.js";

export interface LiveUsageResult {
  rateLimits: RateLimits | null;
  /** If the access token was refreshed, the updated auth to persist. */
  refreshedAuth?: SessionAuth;
  /** Token invalid and refresh failed → user must re-login / re-share. */
  needsReauth?: boolean;
  error?: string;
}

export interface LoginResult {
  auth: SessionAuth;
  email: string | null;
  plan: string | null;
}

export interface LoginOptions {
  /** Called with the authorize URL so the UI can show/print it. */
  onUrl?: (url: string) => void;
  /** For providers that use a paste-the-code flow (Claude). Returns the pasted code. */
  promptCode?: (instructions: string) => Promise<string>;
  timeoutMs?: number;
}

/**
 * Support for running a session in an isolated profile directory ("incognito"):
 * the provider's CLI is launched with its home/config redirected, so it uses
 * the session's own credentials without touching the global login that other
 * running sessions depend on.
 */
export interface IncognitoSupport {
  /** Binary to spawn (assumed on PATH). */
  command: string;
  /** Env vars that redirect the CLI to the profile dir. */
  buildEnv(profileDir: string): Record<string, string>;
  /** Write the session's credentials (and any config) into the profile dir. */
  seed(profileDir: string, auth: SessionAuth): void;
  /** Read rotated credentials back out of the profile dir after the CLI exits. */
  collect(profileDir: string, seeded: SessionAuth): SessionAuth | null;
}

/**
 * A login backend (Codex or Claude Code). It knows how to read/write the live
 * credentials, identify and describe an account, fetch its live 5h/weekly
 * usage, and (optionally) run a browser login to add a new account.
 */
export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly stateDir: string;

  isLoggedIn(): boolean;
  readLiveAuth(): SessionAuth | null;
  writeLiveAuth(auth: SessionAuth): void;

  describeAuth(auth: SessionAuth | null): AuthDescription;
  /** Stable per-account identifier (for detecting the active session). */
  fingerprint(auth: SessionAuth | null): string | null;

  /** Fetch live limits; may refresh + return an updated auth to persist. */
  fetchUsage(auth: SessionAuth): Promise<LiveUsageResult>;

  readonly supportsLogin: boolean;
  runLoginFlow?(opts: LoginOptions): Promise<LoginResult>;

  /** Present when the provider's CLI can run in an isolated profile. */
  readonly incognito?: IncognitoSupport;
}
