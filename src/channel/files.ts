import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SlackFile } from "./slack-ingest.js";
import { log } from "../logger.js";

const logger = log("slack-files");

// Slack allows uploads up to ~1GB. We buffer the bytes to write them, so cap what we pull into the engine
// process (whole-engine blast radius — one big file could OOM the process that drives every agent).
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/** The bot token is attached to the download URL, so only ever send it to a Slack host. */
function isSlackHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "slack.com" || h.endsWith(".slack.com");
  } catch {
    return false;
  }
}

export interface DownloadedFile {
  name: string;
  path: string;
  mimetype: string;
  ok: boolean;
}

/**
 * Download Slack-attached files to the agent's local inbox so its `claude`
 * session can open them with the Read tool. The private download URL requires
 * the bot token AND the `files:read` scope; without that scope Slack returns an
 * HTML login page (not the bytes), which we detect and mark ok=false so the
 * agent can be told the attachment couldn't be fetched instead of failing silent.
 */
export async function downloadFiles(
  files: SlackFile[],
  botToken: string,
  destDir: string,
  tsPrefix: string
): Promise<DownloadedFile[]> {
  if (files.length === 0) return [];
  mkdirSync(destDir, { recursive: true });
  const out: DownloadedFile[] = [];
  for (const f of files) {
    const safe = (f.name || f.id).replace(/[^A-Za-z0-9._-]/g, "_");
    const path = join(destDir, `${tsPrefix}-${safe}`);
    let ok = false;
    const url = f.urlPrivateDownload;
    if (!url) {
      logger.warn({ file: f.name }, "file has no private download url");
    } else if (!isSlackHost(url)) {
      // Don't attach the bot token to a non-Slack host (defense-in-depth on a Slack-supplied URL).
      logger.warn({ file: f.name }, "refusing file download from non-Slack host");
    } else {
      try {
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
        const ct = resp.headers.get("content-type") || "";
        const declared = Number(resp.headers.get("content-length") || "");
        // Slack serves text/html (a login page) when the token lacks files:read.
        if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
          logger.warn({ file: f.name, declared, cap: MAX_FILE_BYTES }, "file exceeds size cap -> skipped");
        } else if (resp.ok && !ct.includes("text/html")) {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length > MAX_FILE_BYTES) {
            logger.warn({ file: f.name, bytes: buf.length, cap: MAX_FILE_BYTES }, "file exceeds size cap -> skipped");
          } else {
            writeFileSync(path, buf, { mode: 0o600 });
            ok = true;
          }
        } else {
          logger.warn({ file: f.name, status: resp.status, ct }, "file download not ok (missing files:read scope?)");
        }
      } catch (err) {
        logger.warn({ file: f.name, err }, "file download failed");
      }
    }
    out.push({ name: f.name, path, mimetype: f.mimetype, ok });
  }
  return out;
}
