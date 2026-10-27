import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";

/**
 * Cloudflare Access JWT verification: proof that a request came through Cloudflare Access from the OWNER, which no agent on this box can fake.
 * Cloudflare adds `Cf-Access-Jwt-Assertion` (an RS256 JWT signed with the team's keys, published at https://<team>/cdn-cgi/access/certs) to every
 * request it lets through an Access-protected hostname. We check the signature against those keys, the issuer (the team), the audience (our Access
 * application tags), the validity window and that the email is the owner's. Anything missing or off fails closed. Only RS256 is accepted (no `none`,
 * no HMAC key-confusion). The token itself is never logged or echoed.
 */
export interface AccessConfig {
  teamDomain: string;   // e.g. "your-team.cloudflareaccess.com"
  audiences: string[];  // AUD tags of the Access applications that front this dashboard
  ownerEmail: string;
}
export interface Jwks { keys: Array<JsonWebKey & { kid?: string }> }
export type AccessResult = { ok: true; email: string } | { ok: false; reason: string };

const b64json = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export async function verifyAccessJwt(
  token: string | undefined,
  cfg: AccessConfig,
  nowMs: number,
  getJwks: (refresh: boolean) => Promise<Jwks | null>
): Promise<AccessResult> {
  const audiences = (cfg.audiences ?? []).filter((a) => typeof a === "string" && a.trim() !== ""); // an empty string in the config must never match an empty aud claim
  if (!cfg.teamDomain || !audiences.length || !cfg.ownerEmail) return { ok: false, reason: "access not configured" };
  if (!token) return { ok: false, reason: "no token" };
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[2]) return { ok: false, reason: "malformed token" };
  const header = b64json(parts[0]!), claims = b64json(parts[1]!);
  if (!header || !claims) return { ok: false, reason: "malformed token" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "unsupported algorithm" };

  let jwks = await getJwks(false);
  let jwk = jwks?.keys?.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwks = await getJwks(true); // an unknown key id may be a rotated key: one rate-limited refresh, then fail closed
    jwk = jwks?.keys?.find((k) => k.kid === header.kid);
  }
  if (!jwk) return { ok: false, reason: "unknown signing key" };
  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    if (!cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"))) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "bad signature" };
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (claims.iss !== `https://${cfg.teamDomain}`) return { ok: false, reason: "wrong issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && audiences.includes(a))) return { ok: false, reason: "wrong audience" };
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > nowSec + 60) return { ok: false, reason: "not yet valid" };
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email || email !== cfg.ownerEmail.trim().toLowerCase()) return { ok: false, reason: "not the owner" };
  return { ok: true, email };
}

/** The team's public keys, cached for an hour; a forced refresh (unknown kid) is allowed at most every 5 minutes. A fetch failure returns the stale copy, or null. */
export function makeJwksProvider(teamDomain: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  let cached: Jwks | null = null, fetchedAt = 0, lastForce = 0;
  return async (refresh: boolean): Promise<Jwks | null> => {
    const t = now();
    const fresh = cached && t - fetchedAt < 3600_000;
    if (fresh && !(refresh && t - lastForce > 300_000)) return cached;
    if (refresh) lastForce = t;
    try {
      const r = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return cached;
      const j = (await r.json()) as Jwks;
      if (!Array.isArray(j?.keys)) return cached;
      cached = j;
      fetchedAt = t;
      return cached;
    } catch {
      return cached;
    }
  };
}
