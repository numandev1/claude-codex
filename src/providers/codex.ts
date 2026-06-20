import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  // Codex honours CODEX_HOME: auth, config, and rollouts all live under the
  // profile dir, fully isolated from ~/.codex.
  incognito: {
    command: "codex",
    buildEnv: (profileDir: string) => ({ CODEX_HOME: profileDir }),
    seed(profileDir: string, auth: SessionAuth): void {
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(profileDir, "auth.json"), JSON.stringify(auth, null, 2), {
        mode: 0o600,
      });
      // Carry the user's global config (model, MCP servers, …) into the
      // profile on first run; after that the profile owns its own copy.
      const globalConfig = path.join(os.homedir(), ".codex", "config.toml");
      const profileConfig = path.join(profileDir, "config.toml");
      if (fs.existsSync(globalConfig) && !fs.existsSync(profileConfig)) {
        fs.copyFileSync(globalConfig, profileConfig);
      }
    },
    collect(profileDir: string): SessionAuth | null {
      try {
        return JSON.parse(fs.readFileSync(path.join(profileDir, "auth.json"), "utf8"));
      } catch {
        return null;
      }
    },
  },
};
