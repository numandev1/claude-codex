import fs from "node:fs";
import path from "node:path";

/**
 * Atomic write: write to a temp file in the same dir, then rename over the
 * target. `secret` writes mode 0600 (token-bearing files).
 */
export function atomicWrite(
  file: string,
  contents: string,
  { secret = false }: { secret?: boolean } = {},
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const mode = secret ? 0o600 : 0o644;
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* best effort */
  }
}
