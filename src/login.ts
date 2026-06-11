import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { decodeJwtPayload } from "./auth.js";
import type { AuthJson } from "./types.js";
import type { LoginResult } from "./providers/provider.js";

// The Codex CLI's own OAuth client. We replicate its login flow so a friend can
// authenticate their ChatGPT account and hand us the resulting tokens.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const PORT = 1455;
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function buildPkce() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));
  return { verifier, challenge, state };
}

function authorizeUrl(challenge: string, state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best effort — the URL is also printed */
  }
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  [k: string]: unknown;
}

async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Best-effort: exchange the id_token for an OpenAI API key, like codex does. */
async function exchangeApiKey(idToken: string): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: CLIENT_ID,
      requested_token: "openai-api-key",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as TokenResponse;
    return (data.access_token as string) || null;
  } catch {
    return null;
  }
}

function accountIdFromIdToken(idToken: string | undefined): string | undefined {
  const claims = decodeJwtPayload(idToken);
  const ns = claims?.["https://api.openai.com/auth"];
  return (ns?.chatgpt_account_id as string) || undefined;
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>codex-session</title>
<style>body{font-family:-apple-system,Arial,sans-serif;background:#0d1117;color:#e6edf3;display:flex;
height:100vh;align-items:center;justify-content:center;margin:0}.card{text-align:center}
h1{color:#3fb950}</style></head><body><div class="card"><h1>✓ Signed in</h1>
<p>This account's session was captured. You can close this tab and return to the terminal.</p>
</div></body></html>`;

/**
 * Run the Codex OAuth + PKCE login flow on localhost:1455. Opens the browser,
 * captures the redirect, and exchanges the code for tokens. Resolves with a
 * fully-formed auth.json object (id/access/refresh + account_id).
 */
export function runLoginFlow({
  timeoutMs = 300_000,
  onUrl,
}: { timeoutMs?: number; onUrl?: (url: string) => void } = {}): Promise<LoginResult> {
  const { verifier, challenge, state } = buildPkce();
  const url = authorizeUrl(challenge, state);

  return new Promise<LoginResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Give the browser a beat to fetch /success, then close.
      setTimeout(() => server.close(), 800);
      fn();
    };

    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || "/", `http://localhost:${PORT}`);
      if (reqUrl.pathname === "/success") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        return;
      }
      if (reqUrl.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const code = reqUrl.searchParams.get("code");
      const gotState = reqUrl.searchParams.get("state");
      const err = reqUrl.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Login error: ${err}`);
        finish(() => reject(new Error(`OAuth error: ${err}`)));
        return;
      }
      if (!code || gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid OAuth callback (state mismatch).");
        finish(() => reject(new Error("OAuth state mismatch — try again.")));
        return;
      }
      try {
        const tok = await exchangeCode(code, verifier);
        if (!tok.id_token || !tok.access_token) {
          throw new Error("Token response missing id_token/access_token.");
        }
        const apiKey = await exchangeApiKey(tok.id_token);
        const auth: AuthJson = {
          OPENAI_API_KEY: apiKey,
          tokens: {
            id_token: tok.id_token,
            access_token: tok.access_token,
            refresh_token: tok.refresh_token,
            account_id: accountIdFromIdToken(tok.id_token),
          },
          last_refresh: new Date().toISOString(),
        };
        const claims = decodeJwtPayload(tok.id_token);
        const ns = claims?.["https://api.openai.com/auth"] || {};
        const email = (claims?.email as string) || null;
        const plan = (ns.chatgpt_plan_type as string) || null;

        res.writeHead(302, { Location: "/success" });
        res.end();
        finish(() => resolve({ auth, email, plan }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Token exchange failed: ${(e as Error).message}`);
        finish(() => reject(e as Error));
      }
    });

    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${PORT} is in use (is \`codex login\` or another get-session running?). Close it and retry.`,
          ),
        );
      } else {
        reject(e);
      }
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error("Login timed out (no callback received).")));
    }, timeoutMs);

    server.listen(PORT, () => {
      onUrl?.(url);
      openBrowser(url);
    });
  });
}
