import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import Dashboard from "./Dashboard.js";
import Brand from "./Brand.js";
import type { DashboardRow } from "../dashboard.js";
import { Engine } from "../engine.js";
import { copyToClipboard, pasteFromClipboard } from "../clipboard.js";
import { runRemoteLoginFlow } from "../remote.js";
import { runningProcessCount, RESUME_HINT, HOT_SWAP } from "../liveProcess.js";
import type { Registry } from "../types.js";

type Mode = "menu" | "save" | "rename" | "confirmDelete" | "acceptName" | "loginCode";
type Status = { kind: "ok" | "err" | "info"; text: string } | null;

const ACCENT: Record<string, string> = { codex: "greenBright", claude: "magentaBright" };

export default function App({ engine, onBack }: { engine: Engine; onBack?: () => void }) {
  const { exit } = useApp();
  const goBack = onBack ?? exit; // return to provider chooser if launched from it, else quit
  const p = engine.provider;
  const accent = ACCENT[p.id] ?? "cyan";
  const cliName = p.id === "codex" ? "codex" : "claude";

  // After a switch: plain "run it" hint, a hot-swap note (Claude picks up the
  // new account live), or a restart warning (Codex keeps the old token in
  // memory until the process exits).
  const switchFollowUp = () => {
    const n = runningProcessCount(p.id);
    if (n === 0) return `Run \`${cliName}\` to use it.`;
    if (HOT_SWAP[p.id]) return `Running ${cliName} sessions pick up the new account automatically.`;
    return `⚠ ${n} running ${cliName} ${n === 1 ? "process keeps" : "processes keep"} the old account — restart, then \`${RESUME_HINT[p.id] ?? cliName}\` to continue your chat.`;
  };

  const suggestName = () => {
    const e = p.describeAuth(p.readLiveAuth()).email;
    return e ? e.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "") : "";
  };

  const [registry, setRegistry] = useState<Registry>(() => engine.syncFromDisk().registry);
  const [unsaved, setUnsaved] = useState<boolean>(() => p.isLoggedIn() && !registry.active);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("menu");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginPrompt, setLoginPrompt] = useState("");
  const pendingBlob = useRef<string | null>(null);
  const codeResolver = useRef<((code: string) => void) | null>(null);
  const cancelLogin = useRef<(() => void) | null>(null);
  const [, setTick] = useState(0);
  const rowsRef = useRef<DashboardRow[]>([]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const reload = useCallback(() => {
    const reg = engine.loadRegistry();
    setRegistry(reg);
    setUnsaved(p.isLoggedIn() && !reg.active);
    const count = Object.keys(reg.sessions).length;
    setSelected((s) => Math.max(0, Math.min(s, Math.max(0, count - 1))));
  }, [engine, p]);

  const refreshInFlight = useRef(false);
  const doRefresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try { await engine.refreshAll(); } catch { /* tolerate */ }
    reload();
    setRefreshing(false);
    refreshInFlight.current = false;
  }, [engine, reload]);

  useEffect(() => { void doRefresh(); }, [doRefresh]);

  // Keep usage genuinely live: re-fetch periodically, not just once on mount.
  useEffect(() => {
    const id = setInterval(() => { void doRefresh(); }, 60_000);
    return () => clearInterval(id);
  }, [doRefresh]);

  const currentRow = (): DashboardRow | undefined => rowsRef.current[selected];

  function run<T>(fn: () => T): T | null {
    try { const r = fn(); reload(); return r; }
    catch (err) { setStatus({ kind: "err", text: (err as Error).message }); return null; }
  }

  const doGetSession = useCallback(async () => {
    if (!engine.supportsLogin) {
      setStatus({ kind: "err", text: `${p.label} login is not supported.` });
      return;
    }
    setBusy(true);
    setStatus({ kind: "info", text: "Opening browser… sign in to the account to add.  (esc = cancel)" });
    try {
      const res = await new Promise<Awaited<ReturnType<typeof engine.getSession>>>((resolve, reject) => {
        cancelLogin.current = () => reject(new Error("Login cancelled."));
        engine.getSession({
          onUrl: (u) => setStatus({ kind: "info", text: `Sign in in the browser…  ${u.slice(0, 54)}…  (esc = cancel)` }),
          promptCode: (instr) =>
            new Promise<string>((resolveCode) => {
              codeResolver.current = resolveCode;
              setLoginPrompt(instr);
              setInput("");
              setMode("loginCode");
            }),
        }).then(resolve).catch(reject);
      });
      cancelLogin.current = null;
      setMode("menu");
      reload();
      setStatus({ kind: "ok", text: `Added "${res.name}" (${res.email ?? "?"} · ${res.plan ?? "?"}). Fetching limits…` });
      void doRefresh();
    } catch (err) {
      cancelLogin.current = null;
      setMode("menu");
      const msg = (err as Error).message;
      setStatus(msg === "Login cancelled."
        ? { kind: "info", text: "Login cancelled." }
        : { kind: "err", text: msg });
    } finally {
      setBusy(false);
    }
  }, [engine, p, reload, doRefresh]);

  const doShare = useCallback(async () => {
    const row = currentRow();
    if (!row) return;
    setBusy(true);
    try {
      const blob = engine.exportBlob(row.name);
      const ok = await copyToClipboard(blob);
      setStatus(ok
        ? { kind: "ok", text: `Token for "${row.name}" copied — send it to your friend.` }
        : { kind: "err", text: `Could not copy. Run: claudecodex ${p.id} share ${row.name} <file>` });
    } catch (err) { setStatus({ kind: "err", text: (err as Error).message }); }
    finally { setBusy(false); }
  }, [engine, p, selected]);

  const doAccept = useCallback(async () => {
    setBusy(true);
    setStatus({ kind: "info", text: "Reading token from clipboard…" });
    try {
      const raw = await pasteFromClipboard();
      if (!raw) { setStatus({ kind: "err", text: `Clipboard empty. Use: claudecodex ${p.id} set <name> @file` }); return; }
      const { auth } = engine.decodeBlob(raw);
      pendingBlob.current = raw;
      setInput(suggestName() || (p.describeAuth(auth).email?.split("@")[0] ?? ""));
      setMode("acceptName");
      setStatus({ kind: "info", text: "Name this borrowed session, then press enter." });
    } catch (err) { setStatus({ kind: "err", text: `No valid token in clipboard: ${(err as Error).message}` }); }
    finally { setBusy(false); }
  }, [engine, p]);

  const doRemoteSession = useCallback(async () => {
    if (p.id !== "codex" && p.id !== "claude") {
      setStatus({ kind: "err", text: "Remote link is only supported for Codex and Claude." });
      return;
    }
    setBusy(true);
    setStatus({ kind: "info", text: "Starting guide page…" });
    const abortCtrl = new AbortController();
    cancelLogin.current = () => abortCtrl.abort();
    try {
      const res = await runRemoteLoginFlow({
        provider: p.id as "codex" | "claude",
        signal: abortCtrl.signal,
        onUrl: (url) => {
          void copyToClipboard(url);
          setStatus({ kind: "info", text: `🔗 Link copied! Send to friend:\n${url}\n\nThey follow 3 steps on that page — token arrives automatically.  esc = cancel` });
        },
      });
      cancelLogin.current = null;
      const suggested = res.email ? res.email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "") : "remote-session";
      engine.persistSession(suggested, res.auth as any, { overwrite: !!engine.loadRegistry().sessions[suggested], setActive: false });
      reload();
      setStatus({ kind: "ok", text: `Remote session saved as "${suggested}". Fetching limits…` });
      void doRefresh();
    } catch (err) {
      cancelLogin.current = null;
      const msg = (err as Error).message;
      setStatus(msg === "Login cancelled." ? { kind: "info", text: "Remote login cancelled." } : { kind: "err", text: msg });
    } finally {
      setBusy(false);
    }
  }, [engine, p, reload, doRefresh]);

  useInput((char, key) => {
    if (busy && mode === "menu") {
      if (key.escape && cancelLogin.current) { cancelLogin.current(); }
      return;
    }

    if (mode === "menu") {
      if (key.upArrow || char === "k") return setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow || char === "j") return setSelected((s) => Math.min(rowsRef.current.length - 1, s + 1));
      if (key.return) {
        const row = currentRow();
        if (!row) return;
        if (row.active) return setStatus({ kind: "info", text: `"${row.name}" is already active.` });
        const r = run(() => engine.useSession(row.name));
        if (r !== null) setStatus({ kind: "ok", text: `Switched to "${row.name}". ${switchFollowUp()}` });
        return;
      }
      if (char === "b") {
        const r = run(() => engine.switchToBest());
        if (r) {
          if (r.switched) setStatus({ kind: "ok", text: `Best: "${r.name}" — 5h ${Math.round(r.primaryFree!)}% free. ${switchFollowUp()}` });
          else if (r.alreadyActive) setStatus({ kind: "info", text: `"${r.name}" is already best & active.` });
          else if (r.allExhausted) setStatus({ kind: "info", text: r.soonest ? `All exhausted. "${r.soonest.name}" resets soonest.` : "All sessions exhausted." });
        }
        return;
      }
      if (char === "g") return void doGetSession();
      if (char === "c") return void doShare();
      if (char === "a") return void doAccept();
      if (char === "s") {
        if (!p.isLoggedIn()) return setStatus({ kind: "err", text: `Not logged in to ${p.label}.` });
        setInput(suggestName()); setStatus(null); setMode("save"); return;
      }
      if (char === "r") return void doRemoteSession();
      if (char === "n") { const row = currentRow(); if (!row) return; setInput(row.name); setStatus(null); setMode("rename"); return; }
      if (char === "d") { if (!currentRow()) return; setStatus(null); setMode("confirmDelete"); return; }
      if (char === "R") { setStatus({ kind: "info", text: "Refreshing…" }); void doRefresh().then(() => setStatus({ kind: "ok", text: "Limits updated." })); return; }
      if (key.ctrl && char === "c") return exit();        // hard quit
      if (char === "q" || key.escape) return goBack();     // back to provider chooser (or quit)
      return;
    }

    if (mode === "save" || mode === "rename" || mode === "acceptName" || mode === "loginCode") {
      if (key.escape) {
        if (mode === "loginCode" && codeResolver.current) { codeResolver.current(""); codeResolver.current = null; }
        setMode("menu"); setInput(""); pendingBlob.current = null; return;
      }
      if (key.return) {
        if (mode === "loginCode") {
          const code = input.trim();
          setMode("menu"); setInput("");
          if (codeResolver.current) { codeResolver.current(code); codeResolver.current = null; }
          return;
        }
        const name = input.trim();
        if (!name) return setStatus({ kind: "err", text: "Name cannot be empty." });
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return setStatus({ kind: "err", text: "Use only letters, digits, _ . -" });
        const exists = !!registry.sessions[name];
        if (mode === "save") {
          const r = run(() => engine.saveCurrent(name, { overwrite: exists }));
          if (r !== null) { setStatus({ kind: "ok", text: `Saved as "${name}". Fetching limits…` }); void doRefresh(); }
        } else if (mode === "rename") {
          const row = currentRow();
          if (row) { const r = run(() => engine.rename(row.name, name)); if (r !== null) setStatus({ kind: "ok", text: `Renamed "${row.name}" → "${name}".` }); }
        } else if (mode === "acceptName") {
          const raw = pendingBlob.current;
          if (raw) { const r = run(() => engine.importBlob(name, raw, { overwrite: exists })); if (r !== null) { setStatus({ kind: "ok", text: `Accepted as "${name}". Fetching limits…` }); void doRefresh(); } }
          pendingBlob.current = null;
        }
        setMode("menu"); setInput(""); return;
      }
      if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
      if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
      return;
    }

    if (mode === "confirmDelete") {
      if (char === "y") { const row = currentRow(); if (row) { const r = run(() => engine.remove(row.name)); if (r !== null) setStatus({ kind: "ok", text: `Deleted "${row.name}".` }); } setMode("menu"); return; }
      if (char === "n" || key.escape) return setMode("menu");
    }
  });

  const statusColor = status?.kind === "ok" ? "green" : status?.kind === "err" ? "red" : "yellow";
  const inputLabel = mode === "save" ? "Save as: " : mode === "rename" ? "Rename to: " : "Name this session: ";

  return (
    <Box flexDirection="column">
      <Brand />
      <Dashboard
        registry={registry}
        selectedIndex={selected}
        rowsRef={rowsRef}
        refreshing={refreshing}
        providerLabel={p.label}
        accent={accent}
      />

      {unsaved ? (
        <Box marginTop={1}>
          <Text color="yellow">⚠ Logged in to {p.label} with an unsaved account. Press [s] to save it.</Text>
        </Box>
      ) : null}

      {status ? (<Box marginTop={1}><Text color={statusColor}>{status.text}</Text></Box>) : null}

      {mode === "save" || mode === "rename" || mode === "acceptName" ? (
        <Box marginTop={1}>
          <Text color="cyan">{inputLabel}</Text><Text>{input}</Text>
          <Text dimColor>▏ (enter = ok, esc = cancel)</Text>
        </Box>
      ) : null}

      {mode === "loginCode" ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">{loginPrompt}</Text>
          <Box><Text>{input.replace(/./g, "•")}</Text><Text dimColor>▏ (enter = ok, esc = cancel)</Text></Box>
        </Box>
      ) : null}

      {mode === "confirmDelete" ? (
        <Box marginTop={1}><Text color="red">{`Delete "${currentRow()?.name}"? Removes its saved login. [y/n]`}</Text></Box>
      ) : null}

      {mode === "menu" && !busy ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>↑/↓ select · enter switch · [b]est · [g]et-new · [s]ave · [r]emote-link</Text>
          <Text dimColor>
            [c]opy-token · [a]ccept-token · [n]ame(rename) · [d]elete · [R]efresh ·{" "}
            {onBack ? "[q] back to providers" : "[q]uit"}
          </Text>
        </Box>
      ) : null}

      {busy && mode === "menu" ? (
        <Box marginTop={1}>
          <Text color="yellow">⏳ working…</Text>
          {cancelLogin.current ? <Text dimColor>  esc = cancel</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
