import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import type { AgentDef } from "../types.js";

/**
 * Live token-usage computed from each agent's Claude transcript JSONL files
 * (~/.claude/projects/<encoded-cwd>/*.jsonl), filtered to a time window. No
 * background ingester — read on demand for the dashboard. Subscription runtime
 * is flat-rate, so these numbers are usage-allowance signal, not dollars.
 */

const PROJECTS = join(homedir(), ".claude", "projects");

/** Claude Code encodes a project dir as the agent's cwd with / and . -> - */
function projectDirFor(agentDir: string): string {
  return agentDir.replace(/[/.]/g, "-");
}

export interface AgentUsage {
  id: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  /** false when the runtime keeps no Claude transcripts (codex/gemini) so usage is unmeasurable → show "n/a", not 0. */
  tracked: boolean;
}

const USAGE_WORKER_TIMEOUT_MS = 120_000;

/**
 * computeUsage in a worker thread, so the ~10 s transcript scan never freezes the engine's event loop (Slack ingest, the deliverer and the
 * dashboard API all share it). It never throws and never hangs:
 *  - a worker that cannot START (module not found, e.g. running from source) falls back to computing inline, inside a try/catch;
 *  - a worker that fails WHILE computing, exits without answering or is silent for 2 minutes (then terminated) rejects, handled by the caller;
 *  - it settles exactly once.
 */
export function computeUsageAsync(agents: AgentDef[], cutoffMs: number): Promise<AgentUsage[]> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => { if (done) return; done = true; if (timer) clearTimeout(timer); fn(); };
    const inline = () => finish(() => { try { resolve(computeUsage(agents, cutoffMs)); } catch (e) { reject(e); } });
    let w: Worker;
    try {
      w = new Worker(new URL("./usage-worker.js", import.meta.url), { workerData: { agents, cutoff: cutoffMs } });
    } catch {
      inline();
      return;
    }
    timer = setTimeout(() => { finish(() => reject(new Error("usage worker timed out"))); void w.terminate(); }, USAGE_WORKER_TIMEOUT_MS);
    w.once("message", (r: AgentUsage[]) => { finish(() => resolve(r)); void w.terminate(); });
    w.once("error", (e: NodeJS.ErrnoException) => {
      if (e && (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "ERR_WORKER_PATH")) inline(); // could not start: compute here
      else finish(() => reject(e));
    });
    w.once("exit", (code) => finish(() => reject(new Error(`usage worker exited (${code}) without an answer`))));
  });
}

export function computeUsage(agents: AgentDef[], cutoffMs: number): AgentUsage[] {
  return agents.map((a) => {
    // Usage is parsed from Claude Code transcripts; non-Claude runtimes don't write them,
    // so their tokens are unmeasurable here (report n/a rather than a misleading 0).
    const tracked = (a.runtime ?? "claude") === "claude";
    const dir = join(PROJECTS, projectDirFor(a.dir));
    let input = 0, output = 0, cr = 0, cc = 0, turns = 0;
    if (tracked && existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        let text: string;
        try {
          text = readFileSync(join(dir, f), "utf8");
        } catch {
          continue;
        }
        for (const line of text.split("\n")) {
          if (!line.includes('"usage"')) continue;
          let m: any;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          const ts = Date.parse(m.timestamp ?? m.ts ?? "");
          if (!Number.isFinite(ts) || ts < cutoffMs) continue;
          const u = (m.message && m.message.usage) || m.usage;
          if (!u) continue;
          input += u.input_tokens || 0;
          output += u.output_tokens || 0;
          cr += u.cache_read_input_tokens || 0;
          cc += u.cache_creation_input_tokens || 0;
          turns++;
        }
      }
    }
    return { id: a.id, input, output, cacheRead: cr, cacheWrite: cc, turns, tracked };
  });
}

export const WINDOW_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "3d": 259_200_000,
  "7d": 604_800_000,
};
