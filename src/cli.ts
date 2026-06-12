#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import React from "react";
import { render } from "ink";
import Root from "./ui/Root.js";
import App from "./ui/App.js";
import { Engine } from "./engine.js";
import { getProvider, PROVIDERS } from "./providers/index.js";
import { renderPlainDashboard } from "./dashboard.js";
import { formatReset } from "./rateLimits.js";
import { midSwitchWarning } from "./liveProcess.js";
import { migrateLegacyCodex } from "./paths.js";
import { maybePromptUpdate, currentVersion } from "./version.js";
import { pasteFromClipboard } from "./clipboard.js";
import { runRemoteLoginFlow } from "./remote.js";

const HELP = `claudecodex v${currentVersion()} — manage multiple Codex and Claude Code logins as sessions

Usage:
  claudecodex                          Pick a provider, then the interactive dashboard
  claudecodex <codex|claude>           Interactive dashboard for that provider
  claudecodex <codex|claude> <command>

Commands (per provider):
  ls                      Print the sessions dashboard (live limits)
  save [name]             Save the current login as a session
  use <name>              Switch the active login to a saved session
  best                    Switch to the session with the most remaining quota
  rename <old> <new>      Rename a session
  delete <name>           Delete a saved session
  refresh                 Fetch live 5h/weekly limits for every session
  get-session [name]      Log a NEW account in via the browser and save it
  remote [name]           Generate a public link — friend opens it, you get their session
  share <name> [outfile]  Print/write a shareable token for a session
  set <name> [tok|@file]  Save a token as a session (default: reads the clipboard)

Examples:
  claudecodex                 # choose Codex or Claude, then manage
  claudecodex codex best
  claudecodex claude ls
`;

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

function header(engine: Engine): string {
  return `[${engine.provider.label}]`;
}

async function runProviderCommand(engine: Engine, cmd: string | undefined, args: string[]): Promise<void> {
  const p = engine.provider;
  switch (cmd) {
    case undefined: {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        engine.syncFromDisk();
        await engine.refreshAll();
        console.log(header(engine) + "\n" + renderPlainDashboard(engine.loadRegistry()));
        return;
      }
      const inst = render(React.createElement(App, { engine }));
      await inst.waitUntilExit();
      return;
    }
    case "ls":
    case "status": {
      engine.syncFromDisk();
      process.stderr.write("Fetching live limits…\n");
      await engine.refreshAll();
      console.log(header(engine) + "\n" + renderPlainDashboard(engine.loadRegistry()));
      break;
    }
    case "save": {
      if (!p.isLoggedIn()) die(`Not logged in to ${p.label}. Log in first, then save.`);
      const d = p.describeAuth(p.readLiveAuth());
      const name = args[0] || (d.email ? d.email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "") : "");
      if (!name) die(`Usage: claudecodex ${p.id} save <name>`);
      try { engine.saveCurrent(name, { overwrite: !!engine.loadRegistry().sessions[name] }); }
      catch (e) { die((e as Error).message); }
      await engine.refreshSession(name);
      console.log(`Saved current ${p.label} login as "${name}".`);
      console.log(renderPlainDashboard(engine.loadRegistry()));
      break;
    }
    case "use":
    case "switch": {
      if (!args[0]) die(`Usage: claudecodex ${p.id} use <name>`);
      try { engine.useSession(args[0]); } catch (e) { die((e as Error).message); }
      console.log(`Switched to "${args[0]}". Run ${p.id === "codex" ? "`codex`" : "`claude`"} to use it.`);
      const warn = midSwitchWarning(p.id);
      if (warn) console.log(warn);
      break;
    }
    case "best": {
      try {
        process.stderr.write("Fetching live limits…\n");
        await engine.refreshAll();
        const r = engine.switchToBest();
        if (r.switched) {
          console.log(`Switched to best: "${r.name}" — 5h ${Math.round(r.primaryFree!)}% free, weekly ${Math.round(r.secondaryFree!)}% free.`);
          const warn = midSwitchWarning(p.id);
          if (warn) console.log(warn);
        }
        else if (r.alreadyActive) console.log(`"${r.name}" is already the best and active.`);
        else if (r.allExhausted) console.log(r.soonest ? `All exhausted. Soonest: "${r.soonest.name}" (${formatReset(r.soonest.window)}).` : "All sessions exhausted.");
      } catch (e) { die((e as Error).message); }
      break;
    }
    case "rename": {
      if (!args[0] || !args[1]) die(`Usage: claudecodex ${p.id} rename <old> <new>`);
      try { engine.rename(args[0], args[1]); } catch (e) { die((e as Error).message); }
      console.log(`Renamed "${args[0]}" → "${args[1]}".`);
      break;
    }
    case "delete":
    case "rm": {
      if (!args[0]) die(`Usage: claudecodex ${p.id} delete <name>`);
      try { engine.remove(args[0]); } catch (e) { die((e as Error).message); }
      console.log(`Deleted "${args[0]}".`);
      break;
    }
    case "refresh": {
      engine.syncFromDisk();
      process.stderr.write("Fetching live limits…\n");
      const outcomes = await engine.refreshAll();
      for (const f of outcomes.filter((o) => !o.ok)) {
        console.error(`  ! ${f.name}: ${f.needsReauth ? `session ended — re-run \`claudecodex ${p.id} get-session\`` : f.error || "failed"}`);
      }
      console.log(renderPlainDashboard(engine.loadRegistry()));
      break;
    }
    case "remote": {
      if (p.id !== "codex" && p.id !== "claude") die("Remote link is only supported for Codex and Claude.");
      let remoteRes;
      try {
        remoteRes = await runRemoteLoginFlow({
          provider: p.id as "codex" | "claude",
          onUrl: (url) => {
            console.log("\n🔗 Send this link to your friend:\n");
            console.log("  " + url + "\n");
            console.log("They open it and follow 3 steps — you'll get the token automatically.\n");
            console.log("Waiting…  Ctrl+C to cancel\n");
          },
        });
      } catch (e) { die((e as Error).message); }
      const suggested =
        (remoteRes.email ? remoteRes.email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "") : "") ||
        args[0] || "remote-session";
      engine.persistSession(suggested, remoteRes.auth as any, {
        overwrite: !!engine.loadRegistry().sessions[suggested],
        setActive: false,
      });
      await engine.refreshSession(suggested);
      console.log(`\nSaved "${suggested}" (${remoteRes.email ?? "unknown"} · ${remoteRes.plan ?? "?"}).`);
      console.log("\n" + renderPlainDashboard(engine.loadRegistry()));
      break;
    }
    case "get-session":
    case "login": {
      if (!engine.supportsLogin) die(`${p.label} login is not supported.`);
      console.log(`Opening browser to sign in to ${p.label}…`);
      let res;
      try {
        res = await engine.getSession({
          onUrl: (u) => console.log("\nIf the browser didn't open, paste this URL:\n  " + u + "\n"),
          promptCode: (instr) => promptLine(instr + "\n> "),
        });
      } catch (e) { die((e as Error).message); }
      await engine.refreshSession(res.name);
      console.log(`\nSaved "${res.name}" (${res.email ?? "unknown"} · ${res.plan ?? "?"}).`);
      console.log("\nShareable token:\n" + engine.exportBlob(res.name));
      console.log("\n" + renderPlainDashboard(engine.loadRegistry()));
      break;
    }
    case "export":
    case "share": {
      if (!args[0]) die(`Usage: claudecodex ${p.id} share <name> [outfile]`);
      let blob: string;
      try { blob = engine.exportBlob(args[0]); } catch (e) { die((e as Error).message); }
      if (args[1]) {
        fs.writeFileSync(args[1], blob + "\n", { mode: 0o600 });
        console.log(`Wrote token for "${args[0]}" → ${args[1]}`);
        console.log(`Friend runs:  claudecodex ${p.id} set <name> @${args[1]}`);
      } else {
        console.log(blob);
        console.error(`\n↑ Send this to your friend; they run:  claudecodex ${p.id} set <name> '<paste>'`);
      }
      break;
    }
    case "import":
    case "set":
    case "add": {
      if (!args[0]) die(`Usage: claudecodex ${p.id} set <name> [token | @file]  (default: reads the clipboard)`);
      let raw = args[1];
      if (raw && raw.startsWith("@")) {
        try { raw = fs.readFileSync(raw.slice(1), "utf8"); } catch (e) { die(`Could not read file: ${(e as Error).message}`); }
      }
      if (!raw) {
        if (process.stdin.isTTY) {
          // Interactive terminal with nothing piped → grab the token from the clipboard.
          raw = (await pasteFromClipboard()) ?? "";
          if (!raw.trim()) die("No token given and the clipboard is empty.\nPaste a token arg, use @file, or pipe it on stdin.");
          process.stderr.write("Using token from clipboard.\n");
        } else {
          raw = fs.readFileSync(0, "utf8"); // piped input
        }
      }
      try { engine.importBlob(args[0], raw, { overwrite: !!engine.loadRegistry().sessions[args[0]] }); }
      catch (e) { die((e as Error).message); }
      await engine.refreshSession(args[0]);
      console.log(`Imported session "${args[0]}".`);
      console.log(renderPlainDashboard(engine.loadRegistry()));
      break;
    }
    default:
      die(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

async function main(): Promise<void> {
  migrateLegacyCodex();
  const argv = process.argv.slice(2);

  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    console.log(HELP);
    return;
  }
  if (argv[0] === "version" || argv[0] === "-v" || argv[0] === "--version") {
    console.log(currentVersion());
    return;
  }

  await maybePromptUpdate();

  // No provider given → interactive chooser (TTY) or guidance.
  if (argv.length === 0) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(HELP);
      return;
    }
    const inst = render(React.createElement(Root));
    await inst.waitUntilExit();
    return;
  }

  const provider = getProvider(argv[0]);
  if (!provider) {
    die(`Specify a provider first: claudecodex <${PROVIDERS.map((p) => p.id).join("|")}> <command>\n\n${HELP}`);
  }
  const engine = new Engine(provider);
  await runProviderCommand(engine, argv[1], argv.slice(2));
}

main().catch((err) => die((err as Error).stack || (err as Error).message));
