// Fleet MCP sign-in: the server is its own small OAuth 2.1 authorization server (MCP SDK router) and delegates the
// identity check to Google. Only the configured, verified e-mail addresses get a token. State lives in one 0600 file.
import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import type { Response, Router } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const DEFAULT_REDIRECTS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];
export const SCOPE = "fleet";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 7 * 24 * 3600;
const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_CLIENTS = 50;

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  sub: string;
  nonce?: string;
}
export type GoogleExchange = (code: string, redirectUri: string, nonce: string) => Promise<GoogleIdentity>;

export interface OAuthConfig {
  publicUrl: URL;
  stateFile: string;
  allowedEmails: string[];
  ownerEmails?: string[]; // addresses the old single pin may belong to
  allowedRedirects: string[];
  googleClientId: string;
  googleExchange: GoogleExchange;
  audit: (event: string, detail?: Record<string, unknown>) => void;
}

interface Grant {
  clientId: string;
  sub: string;
  email?: string;
  revoked?: boolean;
}
interface TokenRec {
  kind: "access" | "refresh";
  grant: string;
  exp: number;
  used?: number | boolean; // epoch seconds of the first use (true = a first-version record, no time known)
  retried?: boolean; // one extra rotation was allowed inside the grace window (only after a restart lost the first reply)
}
interface State {
  clients: Record<string, OAuthClientInformationFull>;
  grants: Record<string, Grant>;
  tokens: Record<string, TokenRec>;
  pins: Record<string, string>;
  pinnedSub?: string;
}
const dict = <T>(o?: Record<string, T>): Record<string, T> =>
  Object.assign(Object.create(null) as Record<string, T>, o);
const MAX_PENDING = 300;
// claude.ai retries a refresh whose reply it lost. A second use of a just-rotated token within this window rotates again instead of
// revoking the grant (that signed the owner out); a replay after it still revokes.
const REFRESH_GRACE_S = 60;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const rand = () => crypto.randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function googleExchangeFromEnv(
  clientId: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): GoogleExchange {
  return async (code, redirectUri) => {
    const r = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: secret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error("google token exchange failed: " + r.status);
    const j = (await r.json()) as { id_token?: string };
    // The id_token comes straight from Google's token endpoint over TLS, so its claims are trusted without a signature check.
    const claims = JSON.parse(
      Buffer.from(String(j.id_token).split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      claims.aud !== clientId ||
      (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com")
    )
      throw new Error("bad id_token audience or issuer");
    if (typeof claims.exp !== "number" || claims.exp < now()) throw new Error("expired id_token");
    return {
      email: String(claims.email ?? "").toLowerCase(),
      emailVerified: claims.email_verified === true,
      sub: String(claims.sub ?? ""),
      nonce: claims.nonce as string | undefined,
    };
  };
}

export class FleetOAuth implements OAuthServerProvider {
  readonly mcpUrl: URL;
  private st: State = { clients: dict(), grants: dict(), tokens: dict(), pins: dict() };
  private pending = new Map<
    string,
    {
      client: OAuthClientInformationFull;
      params: AuthorizationParams;
      cookie: string;
      exp: number;
      gState?: string;
      gNonce?: string;
    }
  >();
  private gStates = new Map<string, { txn: string; exp: number }>();
  // The reply to the FIRST use of a refresh token, kept in memory for the grace window so a retry gets the very same tokens (no second chain).
  private rotated = new Map<string, { tokens: OAuthTokens; exp: number }>();
  private codes = new Map<
    string,
    { client: OAuthClientInformationFull; params: AuthorizationParams; sub: string; email: string; exp: number }
  >();

  constructor(private cfg: OAuthConfig) {
    this.mcpUrl = new URL("/mcp", cfg.publicUrl);
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(cfg.stateFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (raw !== undefined) {
      // A damaged state file must not silently drop the pinned Google account and the grants: refuse to start.
      const j = JSON.parse(raw) as Partial<State>;
      this.st = {
        pinnedSub: j.pinnedSub,
        pins: dict(j.pins),
        clients: dict(j.clients),
        grants: dict(j.grants),
        tokens: dict(j.tokens),
      };
    }
  }

  private save() {
    const tmp = this.cfg.stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 });
    fs.renameSync(tmp, this.cfg.stateFile);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.st.clients[id],
      registerClient: (c) => {
        // Open registration is part of the protocol; the redirect allow-list is what keeps a stranger's client from ever getting a code.
        const uris = (c.redirect_uris ?? []).map(String);
        if (!uris.length || !uris.every((u) => this.cfg.allowedRedirects.includes(u))) {
          this.cfg.audit("register-refused", { redirect: uris.join(" ").slice(0, 200) });
          throw new InvalidClientMetadataError("redirect_uri not allowed");
        }
        const ids = Object.keys(this.st.clients);
        if (ids.length >= MAX_CLIENTS) delete this.st.clients[ids[0]!];
        // Keep only what the flow needs, with a short name: registration is open, so stored size is capped.
        const full = {
          redirect_uris: uris,
          client_name: String(c.client_name ?? "").slice(0, 80),
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: SCOPE,
          client_id: "c_" + rand(),
          client_id_issued_at: now(),
        } as OAuthClientInformationFull;
        this.st.clients[full.client_id] = full;
        this.save();
        this.cfg.audit("client-registered", {
          client: full.client_id,
          name: String(full.client_name ?? "").slice(0, 80),
        });
        return full;
      },
    };
  }

  // Step 1: always ask. The page names the client (attacker controlled, so escaped and labelled) and the redirect host.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && params.resource.href.replace(/\/$/, "") !== this.mcpUrl.href)
      throw new InvalidTargetError("unknown resource");
    const txn = rand(),
      cookie = rand();
    this.pending.set(txn, { client, params, cookie, exp: Date.now() + PENDING_TTL_MS });
    for (const [k, v] of this.pending)
      if (v.exp < Date.now() || this.pending.size > MAX_PENDING) this.pending.delete(k);
    res.cookie("mcp_txn", cookie, {
      httpOnly: true,
      secure: this.cfg.publicUrl.protocol === "https:",
      sameSite: "lax",
      path: "/oauth",
      maxAge: PENDING_TTL_MS,
    });
    res.set({
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'",
    });
    const host = new URL(params.redirectUri).host;
    res.type("html")
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fleet MCP sign-in</title>
<body style="font:16px system-ui;max-width:30em;margin:3em auto;padding:0 1em"><h1>Connect a client?</h1>
<p>A client calling itself <b>${esc(String(client.client_name ?? "unnamed"))}</b> <i>(name is not verified)</i> wants read access to the fleet and will return to <b>${esc(host)}</b>.</p>
<p>Continue only if you started this connection yourself.</p>
<form method="post" action="/oauth/consent"><input type="hidden" name="txn" value="${esc(txn)}"><button style="font-size:1em;padding:.6em 1em">Continue with Google</button></form></body>`);
  }

  router(): Router {
    const r = express.Router();
    r.post("/oauth/consent", express.urlencoded({ extended: false }), (req, res) => {
      const p = this.takePending(String(req.body?.txn ?? ""), req.headers.cookie, false);
      if (!p) return void this.deny(res, "consent-bad-txn");
      const gState = rand(),
        gNonce = rand();
      p.gState = gState;
      p.gNonce = gNonce;
      this.gStates.set(gState, { txn: String(req.body.txn), exp: Date.now() + PENDING_TTL_MS });
      for (const [k, v] of this.gStates)
        if (v.exp < Date.now() || this.gStates.size > MAX_PENDING) this.gStates.delete(k);
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        client_id: this.cfg.googleClientId,
        redirect_uri: new URL("/oauth/google/callback", this.cfg.publicUrl).href,
        response_type: "code",
        scope: "openid email",
        state: gState,
        nonce: gNonce,
        prompt: "select_account",
      }).toString();
      res.redirect(302, u.href);
    });
    r.get("/oauth/google/callback", async (req, res) => {
      const g = this.gStates.get(String(req.query.state ?? ""));
      this.gStates.delete(String(req.query.state ?? ""));
      const txn = g && g.exp > Date.now() ? g.txn : undefined;
      const p = txn ? this.takePending(txn, req.headers.cookie, true) : undefined;
      if (!p || !p.gNonce || typeof req.query.code !== "string") return void this.deny(res, "callback-bad-state");
      let id: GoogleIdentity;
      try {
        id = await this.cfg.googleExchange(
          req.query.code,
          new URL("/oauth/google/callback", this.cfg.publicUrl).href,
          p.gNonce,
        );
      } catch (e) {
        return void this.deny(res, "google-exchange-failed", { err: String((e as Error).message).slice(0, 120) });
      }
      // The allow-list comes first: a stranger's Google account (own nonce, any sign-in against the public client id) must only ever produce the
      // non-tripping "email-not-allowed" event, never "nonce-mismatch", which counts toward the kill switch.
      if (!id.emailVerified || !this.cfg.allowedEmails.includes(id.email))
        return void this.deny(res, "email-not-allowed", { email: id.email.slice(0, 80) });
      if (id.nonce !== p.gNonce) return void this.deny(res, "nonce-mismatch");
      // One Google account per e-mail, pinned on its first login. The single pin of the first version belongs to whichever address it matches.
      const pinned = this.st.pins[id.email];
      if (!id.sub || (pinned && pinned !== id.sub)) return void this.deny(res, "sub-mismatch");
      // The first version pinned ONE Google account for the whole server: it belongs to one of the owner addresses. Until an owner address claims it,
      // an owner address must match it; a member is not bound by it.
      if (
        !pinned &&
        this.st.pinnedSub &&
        (this.cfg.ownerEmails ?? []).includes(id.email) &&
        this.st.pinnedSub !== id.sub
      )
        return void this.deny(res, "sub-mismatch");
      if (!pinned) {
        this.st.pins[id.email] = id.sub;
        if (this.st.pinnedSub === id.sub) delete this.st.pinnedSub;
        this.save();
      }
      const code = rand();
      for (const [k, v] of this.codes) if (v.exp < Date.now() || this.codes.size > MAX_PENDING) this.codes.delete(k);
      this.codes.set(code, {
        client: p.client,
        params: p.params,
        sub: id.sub,
        email: id.email,
        exp: Date.now() + CODE_TTL_MS,
      });
      const back = new URL(p.params.redirectUri);
      back.searchParams.set("code", code);
      if (p.params.state) back.searchParams.set("state", p.params.state);
      this.cfg.audit("login-ok", { client: p.client.client_id });
      res.redirect(302, back.href);
    });
    return r;
  }

  private takePending(txn: string, cookieHeader: string | undefined, consume: boolean) {
    const p = this.pending.get(txn);
    if (!p || p.exp < Date.now()) return undefined;
    const cookie = /(?:^|;\s*)mcp_txn=([^;]+)/.exec(cookieHeader ?? "")?.[1] ?? "";
    if (!same(cookie, p.cookie)) return undefined;
    if (consume) this.pending.delete(txn);
    return p;
  }

  private deny(res: Response, event: string, detail: Record<string, unknown> = {}) {
    this.cfg.audit(event, { denied: true, ...detail });
    res.status(403).type("text/plain").send("Not allowed");
  }

  async challengeForAuthorizationCode(_c: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.exp < Date.now()) throw new InvalidGrantError("invalid code");
    return c.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _v?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code);
    if (!c || c.exp < Date.now() || c.client.client_id !== client.client_id)
      throw new InvalidGrantError("invalid code");
    if (redirectUri && redirectUri !== c.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    const grant = rand();
    this.st.grants[grant] = { clientId: client.client_id, sub: c.sub, email: c.email };
    return this.issue(grant);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const key = sha(refreshToken),
      rec = this.st.tokens[key];
    if (!rec || rec.kind !== "refresh" || rec.exp < now()) throw new InvalidGrantError("invalid refresh token");
    const g = this.st.grants[rec.grant];
    if (!g || g.revoked || g.clientId !== client.client_id) throw new InvalidGrantError("invalid refresh token");
    if (rec.used) {
      const at = typeof rec.used === "number" ? rec.used : 0;
      if (now() - at > REFRESH_GRACE_S) {
        this.revokeGrant(rec.grant);
        this.cfg.audit("refresh-reuse-revoked", { denied: true, client: client.client_id });
        throw new InvalidGrantError("refresh token reused");
      }
      this.cfg.audit("refresh-retry-in-grace", { client: client.client_id });
      const again = this.rotated.get(key);
      if (again && again.exp > Date.now()) return again.tokens; // same reply as the first call: retries never multiply live chains
      // After a restart the first reply is gone: allow exactly ONE more rotation, then it is a replay.
      if (rec.retried) {
        this.revokeGrant(rec.grant);
        this.cfg.audit("refresh-reuse-revoked", { denied: true, client: client.client_id });
        throw new InvalidGrantError("refresh token reused");
      }
      rec.retried = true;
      return this.issue(rec.grant);
    }
    rec.used = now();
    const tokens = this.issue(rec.grant);
    for (const [k, v] of this.rotated) if (v.exp < Date.now()) this.rotated.delete(k);
    this.rotated.set(key, { tokens, exp: Date.now() + REFRESH_GRACE_S * 1000 });
    return tokens;
  }

  private issue(grant: string): OAuthTokens {
    const access = rand(),
      refresh = rand();
    this.st.tokens[sha(access)] = { kind: "access", grant, exp: now() + ACCESS_TTL_S };
    this.st.tokens[sha(refresh)] = { kind: "refresh", grant, exp: now() + REFRESH_TTL_S };
    for (const [k, v] of Object.entries(this.st.tokens)) if (v.exp < now() - 86400) delete this.st.tokens[k];
    this.save();
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: SCOPE,
    };
  }

  revokeGrant(grant: string) {
    if (this.st.grants[grant]) this.st.grants[grant].revoked = true;
    for (const [k, v] of Object.entries(this.st.tokens)) if (v.grant === grant) delete this.st.tokens[k];
    this.save();
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.st.tokens[sha(token)];
    const g = rec && this.st.grants[rec.grant];
    if (!rec || rec.kind !== "access" || rec.exp < now() || !g || g.revoked)
      throw new InvalidTokenError("invalid or expired token");
    // Taking an address off the list ends its sessions at once (a grant of the first version has no e-mail and belongs to the owner).
    if (g.email && !this.cfg.allowedEmails.includes(g.email)) throw new InvalidTokenError("invalid or expired token");
    return {
      token,
      clientId: g.clientId,
      scopes: [SCOPE],
      expiresAt: rec.exp,
      resource: this.mcpUrl,
      extra: { sub: g.sub, email: g.email ?? "" },
    };
  }
}
