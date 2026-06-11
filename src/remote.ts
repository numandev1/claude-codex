import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ngrok from "@ngrok/ngrok";
import { exchangeCode, exchangeApiKey } from "./login.js";
import { decodeJwtPayload } from "./auth.js";
import type { AuthJson } from "./types.js";
import type { LoginResult } from "./providers/provider.js";

// ── Codex (OpenAI) ──────────────────────────────────────────────────────────
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

// ── Claude (Anthropic) ──────────────────────────────────────────────────────
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference";
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_BETA = "oauth-2025-04-20";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function buildPkce() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));
  return { verifier, challenge, state };
}

function buildCodexAuthUrl(challenge: string, state: string): string {
  return (
    CODEX_AUTHORIZE_URL +
    "?" +
    new URLSearchParams({
      response_type: "code",
      client_id: CODEX_CLIENT_ID,
      redirect_uri: CODEX_REDIRECT_URI,
      scope: CODEX_SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "codex_cli_rs",
    }).toString()
  );
}

function buildClaudeAuthUrl(challenge: string, state: string): string {
  return (
    CLAUDE_AUTHORIZE_URL +
    "?" +
    new URLSearchParams({
      response_type: "code",
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: CLAUDE_REDIRECT_URI,
      scope: CLAUDE_SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString()
  );
}

// ── Landing pages ────────────────────────────────────────────────────────────

const _dir = path.dirname(fileURLToPath(import.meta.url));
const codexB64 = readFileSync(path.join(_dir, "../assets/codex-callback.png")).toString("base64");
const claudeB64 = readFileSync(path.join(_dir, "../assets/claude-auth-code.png")).toString("base64");

function buildCodexLandingPage(authUrl: string, showError = false): string {
  const errorBanner = showError
    ? `<div class="alert">That didn't work — the code may have expired. Please sign in again and copy the new URL.</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Access Request</title>
  ${styles()}
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="pill">🔒 Codex Access Request</div>
      <h1>Your friend wants to use Codex<br>with your account</h1>
      <p class="sub">Codex is an AI coding tool. Approving this <strong style="color:#e8e8e8">only</strong> gives access to the Codex tool — nothing else.</p>
    </div>

    <div class="trust">
      <div class="trust-row">
        <div class="trust-col">
          <div class="trust-label shared">What gets shared</div>
          <div class="trust-item"><span class="dot dot-green"></span>Codex tool access only</div>
        </div>
        <div class="trust-col">
          <div class="trust-label private">Stays private</div>
          <div class="trust-item"><span class="dot dot-red"></span>Your ChatGPT chats</div>
          <div class="trust-item"><span class="dot dot-red"></span>Messages &amp; history</div>
          <div class="trust-item"><span class="dot dot-red"></span>Account &amp; password</div>
        </div>
      </div>
    </div>

    ${errorBanner}

    <div class="step">
      <div class="step-header"><div class="num">1</div><h2>Sign in to authorise Codex</h2></div>
      <p>Tap below. A new tab opens — log in with your OpenAI account to grant Codex access.</p>
      <a href="${authUrl}" target="_blank" rel="noopener" class="btn">Authorise Codex Access →</a>
    </div>

    <div class="step">
      <div class="step-header"><div class="num">2</div><h2>Copy the URL from the error page</h2></div>
      <p>After signing in, your browser will show a "This site can't be reached" error. That's expected — look at the <strong style="color:#e8e8e8">address bar</strong> at the top.</p>
      <img src="data:image/png;base64,${codexB64}" alt="browser address bar showing callback URL" class="screenshot">
      <div class="hint">Copy the entire URL from the address bar — it starts with <code style="background:#0f1f0f;padding:1px 5px;border-radius:3px;color:#86efac">localhost:1455/auth/callback?code=…</code></div>
    </div>

    <div class="step">
      <div class="step-header"><div class="num">3</div><h2>Paste it here and submit</h2></div>
      <p>Come back to this tab, paste the URL, and tap Submit. Your friend will get access instantly.</p>
      <form method="POST" action="/submit">
        <textarea name="code" placeholder="localhost:1455/auth/callback?code=..." required autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
        <button type="submit" class="submit">Submit →</button>
      </form>
      <p class="note">Only a Codex API token is transferred. Your password and ChatGPT account are never touched.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildClaudeLandingPage(authUrl: string, showError = false): string {
  const errorBanner = showError
    ? `<div class="alert">That didn't work — the code may have expired. Please sign in again and copy a fresh code.</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Code Access Request</title>
  ${styles()}
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="pill">🔒 Claude Code Access Request</div>
      <h1>Your friend wants to use Claude Code<br>with your account</h1>
      <p class="sub">Claude Code is an AI coding tool. Approving this <strong style="color:#e8e8e8">only</strong> gives access to the Claude Code tool — nothing else.</p>
    </div>

    <div class="trust">
      <div class="trust-row">
        <div class="trust-col">
          <div class="trust-label shared">What gets shared</div>
          <div class="trust-item"><span class="dot dot-green"></span>Claude Code tool access only</div>
        </div>
        <div class="trust-col">
          <div class="trust-label private">Stays private</div>
          <div class="trust-item"><span class="dot dot-red"></span>Your Claude conversations</div>
          <div class="trust-item"><span class="dot dot-red"></span>Messages &amp; history</div>
          <div class="trust-item"><span class="dot dot-red"></span>Account &amp; password</div>
        </div>
      </div>
    </div>

    ${errorBanner}

    <div class="step">
      <div class="step-header"><div class="num">1</div><h2>Sign in to authorise Claude Code</h2></div>
      <p>Tap below. A new tab opens — log in with your Anthropic account to grant Claude Code access.</p>
      <a href="${authUrl}" target="_blank" rel="noopener" class="btn">Authorise Claude Code Access →</a>
    </div>

    <div class="step">
      <div class="step-header"><div class="num">2</div><h2>Copy the code Anthropic shows you</h2></div>
      <p>After signing in, Anthropic shows you this page with a one-time code:</p>
      <img src="data:image/png;base64,${claudeB64}" alt="Anthropic authentication code page" class="screenshot">
      <div class="hint">Tap <strong>Copy Code</strong> on that page, then come back here.</div>
    </div>

    <div class="step">
      <div class="step-header"><div class="num">3</div><h2>Paste the code here and submit</h2></div>
      <p>Come back to this tab, paste the code, and tap Submit. Your friend will get access instantly.</p>
      <form method="POST" action="/submit">
        <textarea name="code" placeholder="Paste the code from Anthropic here…" required autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
        <button type="submit" class="submit">Submit →</button>
      </form>
      <p class="note">Only a Claude Code API token is transferred. Your password and Claude conversations are never touched.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildSuccessPage(email: string | null, providerLabel: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Done</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;background:#060606;color:#e8e8e8;min-height:100vh;display:flex;justify-content:center;align-items:center;text-align:center;padding:24px}
    .icon{font-size:52px;margin-bottom:20px}
    h1{font-size:24px;font-weight:700;color:#fff;margin-bottom:8px}
    p{font-size:14px;color:#737373;line-height:1.7}
    .email{color:#86efac;font-weight:500}
  </style>
</head>
<body>
  <div>
    <div class="icon">✅</div>
    <h1>All done</h1>
    <p>${email ? `Account <span class="email">${email}</span> connected.<br>` : ""}Your friend now has access to the ${providerLabel} tool.<br>You can close this page.</p>
  </div>
</body>
</html>`;
}

function styles(): string {
  return `<style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#060606;color:#e8e8e8;min-height:100vh;padding:32px 16px 48px;display:flex;justify-content:center}
    .wrap{max-width:480px;width:100%}
    /* ── header ── */
    .header{margin-bottom:28px}
    .pill{display:inline-flex;align-items:center;gap:6px;background:#0f1923;border:1px solid #1a3050;border-radius:20px;padding:5px 12px;font-size:11px;font-weight:600;color:#60a5fa;letter-spacing:.4px;text-transform:uppercase;margin-bottom:16px}
    h1{font-size:22px;font-weight:700;color:#fff;line-height:1.3;margin-bottom:6px}
    .sub{font-size:14px;color:#737373;line-height:1.6}
    /* ── trust box ── */
    .trust{background:#090f09;border:1px solid #1a2e1a;border-radius:12px;padding:16px 18px;margin-bottom:24px}
    .trust-row{display:flex;gap:16px}
    .trust-col{flex:1}
    .trust-label{font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;margin-bottom:8px}
    .trust-label.shared{color:#4ade80}
    .trust-label.private{color:#f87171}
    .trust-item{display:flex;align-items:flex-start;gap:6px;font-size:12px;color:#a3a3a3;line-height:1.5;margin-bottom:4px}
    .trust-item .dot{margin-top:3px;flex-shrink:0;width:6px;height:6px;border-radius:50%}
    .dot-green{background:#4ade80}
    .dot-red{background:#f87171}
    /* ── steps ── */
    .step{border:1px solid #1a1a1a;border-radius:12px;padding:20px;margin-bottom:12px;background:#0a0a0a}
    .step-header{display:flex;align-items:center;gap:12px;margin-bottom:12px}
    .num{width:26px;height:26px;border-radius:50%;background:#1e3a6e;color:#93c5fd;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .step h2{font-size:14px;font-weight:600;color:#e8e8e8}
    .step p{font-size:13px;color:#737373;line-height:1.6}
    .btn{display:block;width:100%;padding:14px;background:#1d4ed8;color:#fff;font-weight:600;font-size:14px;border:none;border-radius:8px;cursor:pointer;text-align:center;text-decoration:none;margin-top:14px;transition:background .15s}
    .btn:hover{background:#2563eb}
    .btn:active{background:#1e40af}
    img.screenshot{width:100%;border-radius:8px;margin-top:14px;border:1px solid #1e1e1e;display:block}
    .hint{background:#0a0f0a;border:1px solid #1a2a1a;border-radius:8px;padding:10px 13px;font-size:12px;color:#86efac;margin-top:12px;line-height:1.6}
    textarea{width:100%;background:#0a0a0a;border:1px solid #262626;border-radius:8px;color:#e8e8e8;font-family:monospace;font-size:12px;padding:11px 13px;margin-top:12px;height:82px;resize:none;line-height:1.5;outline:none;transition:border .15s}
    textarea:focus{border-color:#2563eb}
    textarea::placeholder{color:#404040}
    .submit{width:100%;padding:13px;background:#1d4ed8;color:#fff;font-weight:600;font-size:14px;border:none;border-radius:8px;cursor:pointer;margin-top:10px;transition:background .15s}
    .submit:hover{background:#2563eb}
    .note{font-size:11px;color:#404040;margin-top:8px;line-height:1.5}
    .alert{background:#1a0a0a;border:1px solid #450a0a;border-radius:8px;padding:13px;font-size:13px;color:#fca5a5;margin-bottom:16px;line-height:1.5}
  </style>`;
}

// ── Token exchange helpers ────────────────────────────────────────────────────

async function exchangeCodexCode(
  rawInput: string,
  verifier: string,
  state: string,
): Promise<LoginResult> {
  const trimmed = rawInput.trim();
  let code: string;
  const isCallbackUrl =
    trimmed.startsWith("http://localhost:1455") || trimmed.startsWith("localhost:1455");
  if (isCallbackUrl) {
    const parsed = new URL(trimmed.startsWith("http") ? trimmed : "http://" + trimmed);
    const urlCode = parsed.searchParams.get("code");
    if (!urlCode) throw new Error("No code found in that URL.");
    const urlState = parsed.searchParams.get("state");
    if (urlState && urlState !== state)
      throw new Error("This URL belongs to a different session. Please sign in again.");
    code = urlCode;
  } else {
    code = trimmed;
  }

  const tok = await exchangeCode(code, verifier);
  if (!tok.id_token || !tok.access_token)
    throw new Error("Code expired — please sign in again (codes last ~60 seconds).");
  const apiKey = await exchangeApiKey(tok.id_token);
  const claims = decodeJwtPayload(tok.id_token);
  const ns = (claims?.["https://api.openai.com/auth"] as Record<string, unknown>) ?? {};
  const auth: AuthJson = {
    OPENAI_API_KEY: apiKey,
    tokens: {
      id_token: tok.id_token,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      account_id: (ns.chatgpt_account_id as string) ?? undefined,
    },
    last_refresh: new Date().toISOString(),
  };
  return {
    auth,
    email: (claims?.email as string) ?? null,
    plan: (ns.chatgpt_plan_type as string) ?? null,
  };
}

async function exchangeClaudeCode(
  rawInput: string,
  verifier: string,
  state: string,
): Promise<LoginResult> {
  // Claude shows just a code string (may be "code#state" format)
  const code = rawInput.trim().split("#")[0].split("&")[0].trim();
  if (!code) throw new Error("No code found. Please copy the code shown by Anthropic.");

  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "anthropic-beta": CLAUDE_BETA,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT_URI,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
  }
  const data: any = await res.json();
  if (!data?.access_token) throw new Error("Token response missing access_token.");

  const blob: Record<string, unknown> = {
    claudeAiOauth: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scopes: typeof data.scope === "string" ? data.scope.split(" ") : undefined,
      subscriptionType: data.subscription_type ?? undefined,
    },
  };

  let email: string | null = null;
  try {
    const prof = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
        "anthropic-beta": CLAUDE_BETA,
        Accept: "application/json",
      },
    });
    if (prof.ok) {
      const p: any = await prof.json();
      email = p?.account?.email || p?.email || null;
      const org = p?.organization?.uuid || p?.organization_uuid;
      if (org) blob.organizationUuid = org;
      const sub = p?.account?.subscription_type || p?.subscription_type;
      if (sub) (blob.claudeAiOauth as any).subscriptionType = sub;
    }
  } catch { /* best effort */ }

  if (email) blob.email = email;

  return {
    auth: blob as any,
    email,
    plan: (blob.claudeAiOauth as any)?.subscriptionType || null,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface RemoteLoginOptions {
  provider: "codex" | "claude";
  signal?: AbortSignal;
  onUrl: (url: string) => void;
}

export async function runRemoteLoginFlow(opts: RemoteLoginOptions): Promise<LoginResult> {
  const authtoken = process.env.NGROK_AUTHTOKEN;
  if (!authtoken) {
    throw new Error(
      "NGROK_AUTHTOKEN is not set.\n\n" +
      "To use remote sessions:\n" +
      "  1. Sign up free at https://ngrok.com\n" +
      "  2. Copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken\n" +
      "  3. Run:  export NGROK_AUTHTOKEN=<your-token>\n" +
      "  4. Then press [r] again.",
    );
  }

  const { verifier, challenge, state } = buildPkce();
  const isCodex = opts.provider === "codex";
  const authUrl = isCodex
    ? buildCodexAuthUrl(challenge, state)
    : buildClaudeAuthUrl(challenge, state);
  const providerLabel = isCodex ? "Codex" : "Claude";

  const port = 13456 + Math.floor(Math.random() * 500);

  return new Promise<LoginResult>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };

    const server = http.createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(isCodex ? buildCodexLandingPage(authUrl) : buildClaudeLandingPage(authUrl));
        return;
      }

      if (req.method === "POST" && req.url === "/submit") {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk));
        req.on("end", async () => {
          try {
            const params = new URLSearchParams(body);
            const rawInput = (params.get("code") ?? "").trim();
            if (!rawInput) throw new Error("Nothing was pasted.");

            const result = isCodex
              ? await exchangeCodexCode(rawInput, verifier, state)
              : await exchangeClaudeCode(rawInput, verifier, state);

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(buildSuccessPage(result.email, providerLabel));

            finish(() => {
              server.close();
              resolve(result);
            });
          } catch {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              isCodex
                ? buildCodexLandingPage(authUrl, true)
                : buildClaudeLandingPage(authUrl, true),
            );
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.on("error", (err) =>
      finish(() => reject(new Error(`Server error: ${err.message}`))),
    );

    server.listen(port, async () => {
      try {
        const listener = await ngrok.forward({ addr: port, authtoken });

        const abortHandler = () => {
          finish(() => {
            void listener.close();
            server.close();
            reject(new Error("Login cancelled."));
          });
        };
        opts.signal?.addEventListener("abort", abortHandler);

        opts.onUrl(listener.url() ?? "");
      } catch (err) {
        server.close();
        reject(new Error(`Could not start tunnel: ${(err as Error).message}`));
      }
    });
  });
}
