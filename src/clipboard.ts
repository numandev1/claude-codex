import { spawn } from "node:child_process";

interface ClipTool {
  copy: [string, string[]];
  paste: [string, string[]];
}

function toolFor(): ClipTool | null {
  if (process.platform === "darwin") {
    return { copy: ["pbcopy", []], paste: ["pbpaste", []] };
  }
  if (process.platform === "win32") {
    return { copy: ["clip", []], paste: ["powershell", ["-NoProfile", "-Command", "Get-Clipboard"]] };
  }
  // Linux: prefer wl-copy/wl-paste (Wayland), fall back to xclip.
  return { copy: ["xclip", ["-selection", "clipboard"]], paste: ["xclip", ["-selection", "clipboard", "-o"]] };
}

export async function copyToClipboard(text: string): Promise<boolean> {
  const tool = toolFor();
  if (!tool) return false;
  return new Promise((resolve) => {
    try {
      const child = spawn(tool.copy[0], tool.copy[1]);
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

export async function pasteFromClipboard(): Promise<string | null> {
  const tool = toolFor();
  if (!tool) return null;
  return new Promise((resolve) => {
    try {
      const child = spawn(tool.paste[0], tool.paste[1]);
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve(null));
      child.on("close", () => resolve(out));
    } catch {
      resolve(null);
    }
  });
}
