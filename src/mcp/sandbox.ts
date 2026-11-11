// sandbox_check: lets a member's claude.ai (which cannot reach *.pages.dev) probe a sandbox's previews.
// Locked to https://<base> and https://<labels>.<base>, the base host coming from FLEET_MCP_SANDBOX_HOST (tenant config,
// never code); with no base the tool refuses. The check is on the RAW
// authority too, so userinfo, ports, backslashes and percent tricks never reach the URL parser's leniency.
export const SANDBOX_MAX_BYTES = 2048;
export const SANDBOX_TIMEOUT_MS = 10_000;
const hostRe = (base: string) => new RegExp(`^([a-z0-9-]+\\.)*${base.toLowerCase().replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}$`);

export function sandboxUrl(raw: string, base: string): URL | null {
  if (!/^[a-z0-9.-]+$/i.test(base) || !base.includes(".")) return null;
  const HOST = hostRe(base);
  const m = /^https:\/\/([^/?#]*)/i.exec(raw);
  if (!m || /[\s\\@:%]/.test(m[1]!) || /[\s\\]/.test(raw)) return null;
  if (!HOST.test(m[1]!.toLowerCase())) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !HOST.test(u.hostname)) return null;
  return u;
}

export type SandboxResult =
  | { ok: true; status: number; body: string; truncated: boolean; redirect?: string }
  | { ok: false; error: string };

export async function sandboxCheck(
  fetchImpl: typeof fetch,
  base: string,
  url: string,
  method: string,
  body?: string,
  timeoutMs = SANDBOX_TIMEOUT_MS,
): Promise<SandboxResult> {
  const u = sandboxUrl(url, base);
  if (!u) return { ok: false, error: "ez a cim nem engedett (csak a beallitott sandbox host)" };
  if (method !== "GET" && method !== "POST") return { ok: false, error: "csak GET vagy POST" };
  if (method === "GET" && body !== undefined) return { ok: false, error: "GET-hez nincs body" };
  if (body !== undefined && Buffer.byteLength(body) > SANDBOX_MAX_BYTES)
    return { ok: false, error: `a body legfeljebb ${SANDBOX_MAX_BYTES} bajt` };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(u.toString(), {
      method,
      redirect: "manual",
      signal: ctl.signal,
      ...(body !== undefined ? { body, headers: { "Content-Type": "application/json" } } : {}),
    });
    const chunks: Uint8Array[] = [];
    let got = 0;
    if (r.body) {
      const rd = r.body.getReader();
      while (got <= SANDBOX_MAX_BYTES) {
        const { done, value } = await rd.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
      }
      void rd.cancel().catch(() => {});
    }
    const buf = Buffer.concat(chunks);
    const loc = r.headers.get("location");
    return {
      ok: true,
      status: r.status,
      body: buf.subarray(0, SANDBOX_MAX_BYTES).toString("utf8"),
      truncated: buf.length > SANDBOX_MAX_BYTES,
      ...(loc ? { redirect: loc } : {}),
    };
  } catch (e) {
    return { ok: false, error: ctl.signal.aborted ? `idotullepes (${timeoutMs} ms)` : `hiba: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
