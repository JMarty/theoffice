import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadConfig } from "../config.js";
import { getDb } from "../db/index.js";
import { log } from "../logger.js";

const logger = log("update");

/** Best-effort clean SQLite snapshot before an update (VACUUM INTO includes WAL, unlike a raw file copy). */
function backupDb(): void {
  try {
    const dbFile = loadConfig().paths.dbFile;
    if (!existsSync(dbFile)) return;
    const dst = `${dbFile}.pre-update.bak`;
    if (existsSync(dst)) rmSync(dst);
    getDb().exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
    logger.info({ dst }, "pre-update db backup written");
  } catch (e) {
    logger.warn({ e }, "pre-update db backup failed (continuing with update)");
  }
}

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
export function applyUpdate(opts?: { discardLocal?: boolean }): {
  ok: boolean;
  output: string;
  dirty?: boolean;
  files?: string[];
} {
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

  // A dirty working tree makes `git pull --ff-only` abort with a cryptic "your local changes would be
  // overwritten" error — the #1 self-host update snag. Detect locally-modified TRACKED files up front
  // (porcelain, untracked excluded) and surface a clear, actionable result instead of the raw git failure.
  const dirtyFiles = git(["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).split(" -> ").pop()!.trim())
    .filter(Boolean);
  if (dirtyFiles.length) {
    if (!opts?.discardLocal) {
      return {
        ok: false,
        dirty: true,
        files: dirtyFiles,
        output:
          `Update blocked — you have local changes to:\n  ${dirtyFiles.join("\n  ")}\n\n` +
          `These would be overwritten by the update. Either:\n` +
          `  • use "Discard local changes & update" (saves your edits to git stash, then takes the official version), or\n` +
          `  • run \`git stash\` in a terminal to set them aside, then retry the update.`,
      };
    }
    // Explicit opt-in: stash (NOT destroy) so the user's edits stay recoverable via `git stash pop`.
    step("git", ["stash", "push", "-m", "office-update: auto-stash before pull"]);
  }

  // Capture the exact pre-pull commit so a failed build can roll the source tree back to a known-good state
  // (otherwise a build-break mid-update leaves source/dist mismatched until someone fixes it by hand).
  let head = "";
  try {
    head = git(["rev-parse", "HEAD"]).trim();
  } catch {
    /* first run / detached — rollback simply skipped */
  }
  backupDb(); // clean snapshot before we touch anything, so a bad update never risks the tenant DB

  try {
    step("git", ["pull", "--ff-only", "origin", "main"]);
    // `npm ci` (not install) for a reproducible build straight from the committed lockfile — no drift.
    step("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"]);
    step("npm", ["run", "build"]);
    // Re-install the office-say helper: agents call it to reply, and an upstream change to office-say.sh
    // would otherwise never reach ~/.local/bin (they'd keep calling the stale copy). -D creates the dir.
    const home = process.env.HOME ?? "";
    step("install", ["-D", "-m", "0755", join(REPO_ROOT, "scripts", "office-say.sh"), join(home, ".local", "bin", "office-say")]);
  } catch (e) {
    if (head) {
      try {
        out.push(execFileSync("git", ["-C", REPO_ROOT, "reset", "--hard", head], { encoding: "utf8" }).trim());
        logger.warn({ head }, "update failed -> rolled source back to pre-pull HEAD");
      } catch (re) {
        logger.error({ re }, "rollback failed");
      }
    }
    throw e;
  }

  // restart shortly after we've returned the response (success branch only)
  setTimeout(() => {
    try {
      execFileSync("systemctl", ["--user", "restart", "theoffice.service"]);
    } catch (e) {
      logger.error({ e }, "post-update restart failed");
    }
  }, 1000);
  return { ok: true, output: out.join("\n") };
}
