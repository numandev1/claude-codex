import {
  readLiveAuth,
  writeLiveAuth,
  isLoggedIn,
  describeAuth,
  fingerprint,
} from "../auth.js";
import { fetchLiveUsage } from "../usage.js";
import { runLoginFlow } from "../login.js";
import { providerStateDir } from "../paths.js";
import type { AuthJson, AuthDescription, SessionAuth } from "../types.js";
import type { LiveUsageResult, LoginOptions, LoginResult, Provider } from "./provider.js";

/** Codex CLI provider: login lives in ~/.codex/auth.json; limits from wham/usage. */
export const codexProvider: Provider = {
  id: "codex",
  label: "Codex (ChatGPT)",
  stateDir: providerStateDir("codex"),
  supportsLogin: true,

  isLoggedIn: () => isLoggedIn(),
  readLiveAuth: () => readLiveAuth(),
  writeLiveAuth: (auth: SessionAuth) => writeLiveAuth(auth as AuthJson),
  describeAuth: (auth: SessionAuth | null): AuthDescription => describeAuth(auth as AuthJson | null),
  fingerprint: (auth: SessionAuth | null) => fingerprint(auth as AuthJson | null),
  fetchUsage: (auth: SessionAuth): Promise<LiveUsageResult> => fetchLiveUsage(auth as AuthJson),
  runLoginFlow: (opts: LoginOptions): Promise<LoginResult> =>
    runLoginFlow({ onUrl: opts.onUrl, timeoutMs: opts.timeoutMs }),
};
