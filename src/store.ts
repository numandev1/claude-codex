import fs from "node:fs";
import {
  registryFile,
  snapshotPath,
  ensureDir,
} from "./paths.js";
import { atomicWrite } from "./fsutil.js";
import type { Registry, SessionAuth } from "./types.js";

/**
 * A registry/snapshot store bound to one provider's state directory. All token
 * material lives under `dir`; nothing leaks into ~/.codex or ~/.claude.
 */
export class Store {
  constructor(private readonly dir: string) {}

  loadRegistry(): Registry {
    ensureDir(this.dir);
    try {
      const raw = fs.readFileSync(registryFile(this.dir), "utf8");
      const parsed = JSON.parse(raw) as Partial<Registry>;
      return { active: parsed.active ?? null, sessions: parsed.sessions ?? {} };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return { active: null, sessions: {} };
      throw new Error(`Could not read registry at ${registryFile(this.dir)}: ${e.message}`);
    }
  }

  saveRegistry(registry: Registry): void {
    ensureDir(this.dir);
    atomicWrite(registryFile(this.dir), JSON.stringify(registry, null, 2) + "\n");
  }

  readSnapshot(name: string): SessionAuth {
    return JSON.parse(fs.readFileSync(snapshotPath(this.dir, name), "utf8")) as SessionAuth;
  }

  writeSnapshot(name: string, auth: SessionAuth): void {
    atomicWrite(snapshotPath(this.dir, name), JSON.stringify(auth, null, 2) + "\n", { secret: true });
  }

  snapshotExists(name: string): boolean {
    return fs.existsSync(snapshotPath(this.dir, name));
  }

  deleteSnapshot(name: string): void {
    try {
      fs.unlinkSync(snapshotPath(this.dir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
