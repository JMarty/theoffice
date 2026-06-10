import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../config.js";
import { log } from "../logger.js";

const logger = log("update");

function git(args: string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
}

export interface PendingCommit {
  hash: string;
  subject: string;
  body: string;
}

/** Fetch origin and list commits the local install is behind (HEAD..origin/main). */
export function checkUpdates(): { current: string; behind: number; commits: PendingCommit[]; error?: string } {
  try {
    git(["fetch", "--quiet", "origin"]);
  } catch (e) {
    return { current: "?", behind: 0, commits: [], error: "git fetch failed: " + String(e) };
  }
  const current = git(["rev-parse", "--short", "HEAD"]).trim();
  let raw = "";
  try {
    // unit/record separators so multi-line bodies stay intact
    raw = git(["log", "--no-merges", "--pretty=format:%h%x1f%s%x1f%b%x1e", "HEAD..origin/main"]);
  } catch {
    raw = "";
  }
  const commits = raw
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [hash, subject, body] = c.split("\x1f");
      return { hash: (hash ?? "").trim(), subject: (subject ?? "").trim(), body: (body ?? "").trim() };
    });
  return { current, behind: commits.length, commits };
}

/**
 * Pull + reinstall deps + rebuild, then restart the engine (detached, just after we
 * return so the HTTP response still completes). Agents' tmux sessions survive — the
 * tmux server is a separate unit.
 */
export function applyUpdate(): { ok: boolean; output: string } {
  const out: string[] = [];
  const step = (cmd: string, args: string[]) => {
    out.push(`$ ${cmd} ${args.join(" ")}`);
    try {
      out.push(execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim());
    } catch (e: any) {
      out.push("FAILED: " + (e?.stdout || "") + (e?.stderr || "") + String(e?.message || e));
      throw new Error(out.join("\n"));
    }
  };
  step("git", ["pull", "--ff-only", "origin", "main"]);
  step("npm", ["install", "--no-audit", "--no-fund"]);
  step("npm", ["run", "build"]);
  // restart shortly after we've returned the response
  setTimeout(() => {
    try {
      execFileSync("systemctl", ["--user", "restart", "theoffice.service"]);
    } catch (e) {
      logger.error({ e }, "post-update restart failed");
    }
  }, 1000);
  return { ok: true, output: out.join("\n") };
}
