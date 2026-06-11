import http from "node:http";
import crypto from "node:crypto";
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

function buildCodexLandingPage(authUrl: string, showError = false): string {
  const errorBanner = showError
    ? `<div class="alert">⚠️ That didn't work — the code may have expired. Please sign in again and copy the new URL.</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Your ChatGPT Account</title>
  ${styles()}
</head>
<body>
  <div class="card">
    <div class="logo">🔑</div>
    <h1>Connect Your ChatGPT Account</h1>
    <p class="sub">Your friend wants to borrow your ChatGPT Plus access for Codex.<br>Takes about 1 minute. No password shared.</p>
    ${errorBanner}
    <div class="step">
      <div class="num">1</div>
      <h2>Sign in with ChatGPT</h2>
      <p>Tap the button below. A new page will open — log in with your ChatGPT account.</p>
      <a href="${authUrl}" target="_blank" rel="noopener" class="btn">Sign in with ChatGPT →</a>
    </div>
    <div class="step">
      <div class="num">2</div>
      <h2>You'll see an error page — that's normal</h2>
      <p>After signing in, the browser redirects and shows a <strong>"This site can't be reached"</strong> error. That's expected.</p>
      <div class="tip">📋 Look at your browser's <strong>address bar</strong> — it shows a URL starting with <code>localhost:1455/auth/callback?code=…</code><br><br>Copy that entire URL.</div>
    </div>
    <div class="step">
      <div class="num">3</div>
      <h2>Paste the URL below and submit</h2>
      <p>Come back to this page, paste the URL you copied, and hit Submit.</p>
      <form method="POST" action="/submit">
        <textarea name="code" placeholder="localhost:1455/auth/callback?code=..." required autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
        <button type="submit" class="submit">Submit →</button>
      </form>
      <p class="note">This sends only an auth token to your friend's computer. Your password is never shared.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildClaudeLandingPage(authUrl: string, showError = false): string {
  const errorBanner = showError
    ? `<div class="alert">⚠️ That didn't work — the code may have expired. Please sign in again and copy a fresh code.</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Your Claude Account</title>
  ${styles()}
</head>
<body>
  <div class="card">
    <div class="logo">🤖</div>
    <h1>Connect Your Claude Account</h1>
    <p class="sub">Your friend wants to borrow your Claude Pro access.<br>Takes about 1 minute. No password shared.</p>
    ${errorBanner}
    <div class="step">
      <div class="num">1</div>
      <h2>Sign in with Claude</h2>
      <p>Tap the button below. A new page will open — log in with your Anthropic / Claude account.</p>
      <a href="${authUrl}" target="_blank" rel="noopener" class="btn">Sign in with Claude →</a>
    </div>
    <div class="step">
      <div class="num">2</div>
      <h2>Copy the code shown by Anthropic</h2>
      <p>After signing in, Anthropic will show you a page with a <strong>code</strong> on it.</p>
      <div class="tip">📋 Copy that code — it looks like a long string of letters and numbers.</div>
    </div>
    <div class="step">
      <div class="num">3</div>
      <h2>Paste the code below and submit</h2>
      <p>Come back to this page, paste the code you copied, and hit Submit.</p>
      <form method="POST" action="/submit">
        <textarea name="code" placeholder="Paste the code from Anthropic here…" required autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
        <button type="submit" class="submit">Submit →</button>
      </form>
      <p class="note">This sends only an auth token to your friend's computer. Your password is never shared.</p>
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
  <title>All done!</title>
  <style>
    body{font-family:-apple-system,sans-serif;background:#0d0d0d;color:#e5e5e5;min-height:100vh;display:flex;justify-content:center;align-items:center;text-align:center;padding:24px}
    .icon{font-size:64px;margin-bottom:20px}
    h1{font-size:26px;font-weight:700;color:#10b981;margin-bottom:10px}
    p{font-size:15px;color:#888;line-height:1.6}
    .email{color:#6ee7b7;font-weight:600}
  </style>
</head>
<body>
  <div>
    <div class="icon">✅</div>
    <h1>You're all set!</h1>
    <p>${email ? `Account <span class="email">${email}</span> connected.<br>` : ""}Your friend now has access to your ${providerLabel} session.<br>You can close this page.</p>
  </div>
</body>
</html>`;
}

function styles(): string {
  return `<style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d0d0d;color:#e5e5e5;min-height:100vh;padding:24px 16px;display:flex;justify-content:center}
    .card{max-width:460px;width:100%}
    .logo{font-size:32px;margin-bottom:8px}
    h1{font-size:20px;font-weight:700;color:#fff;margin-bottom:4px}
    .sub{font-size:14px;color:#888;margin-bottom:28px;line-height:1.5}
    .step{background:#161616;border:1px solid #2a2a2a;border-radius:14px;padding:20px;margin-bottom:14px}
    .num{width:30px;height:30px;border-radius:50%;background:#10b981;color:#000;font-weight:800;font-size:13px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px}
    .step h2{font-size:15px;font-weight:600;color:#fff;margin-bottom:6px}
    .step p{font-size:13px;color:#999;line-height:1.6}
    .btn{display:block;width:100%;padding:15px;background:#10b981;color:#000;font-weight:700;font-size:15px;border:none;border-radius:10px;cursor:pointer;text-align:center;text-decoration:none;margin-top:14px}
    .btn:active{opacity:.85}
    code{background:#1e1e1e;color:#6ee7b7;padding:2px 6px;border-radius:4px;font-size:12px;word-break:break-all}
    textarea{width:100%;background:#111;border:1px solid #333;border-radius:8px;color:#e5e5e5;font-family:monospace;font-size:12px;padding:10px 12px;margin-top:10px;height:86px;resize:vertical;line-height:1.5}
    textarea:focus{outline:none;border-color:#10b981}
    textarea::placeholder{color:#555}
    .submit{width:100%;padding:14px;background:#10b981;color:#000;font-weight:700;font-size:15px;border:none;border-radius:10px;cursor:pointer;margin-top:10px}
    .note{font-size:11px;color:#555;margin-top:8px;line-height:1.5}
    .alert{background:#2d0e0e;border:1px solid #6b2020;border-radius:10px;padding:14px;font-size:13px;color:#f87171;margin-bottom:16px;line-height:1.5}
    .tip{background:#0e1f1a;border:1px solid #1a3d30;border-radius:8px;padding:10px 12px;font-size:12px;color:#6ee7b7;margin-top:10px;line-height:1.6}
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
  const providerLabel = isCodex ? "ChatGPT" : "Claude";

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
