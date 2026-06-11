import { codexProvider } from "./codex.js";
import { claudeProvider } from "./claude.js";
import type { Provider } from "./provider.js";

export const PROVIDERS: Provider[] = [codexProvider, claudeProvider];

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export type { Provider } from "./provider.js";
