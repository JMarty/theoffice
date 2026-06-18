/**
 * Pure, table-testable decision logic for the exec-style runtimes (codex, gemini). A "turn" is one
 * subprocess; when it finishes (clean exit / non-zero / spawn error / watchdog kill) we must decide what
 * happens to the queue item. Keeping that decision OUT of the async child wiring lets us unit-test every
 * branch (exit0+completed -> delivered, exit0+usage -> hold, watchdog -> retry, ...) without spawning.
 *
 * The three outcomes map onto the queue's three terminal moves:
 *   - "delivered" -> markDelivered
 *   - "usage"     -> requeueNoPenalty + cooldown (transient external cap, NOT the message's fault)
 *   - "retry"     -> requeue (bounded by MAX_DELIVERY_ATTEMPTS, then markFailed)
 */
export type ExecOutcome =
  | { kind: "delivered" }
  | { kind: "usage" }
  | { kind: "retry"; why: string };

export interface CodexSignals {
  /** child exit code (null = killed by signal) */
  code: number | null;
  /** saw a `turn.completed` JSON event on stdout */
  sawCompleted: boolean;
  /** matched the usage/rate-limit heuristic on stdout or stderr */
  sawUsageLimit: boolean;
  /** the node-side watchdog killed a hung turn */
  timedOut?: boolean;
}

/**
 * Codex completion is the structured `turn.completed` event AND a clean exit. A usage cap takes
 * precedence (transient, hold without burning the budget); a watchdog kill is a genuine miss to retry.
 */
export function decideCodexOutcome(s: CodexSignals): ExecOutcome {
  if (s.sawUsageLimit) return { kind: "usage" };
  if (s.timedOut) return { kind: "retry", why: "turn watchdog timeout" };
  if (s.code === 0 && s.sawCompleted) return { kind: "delivered" };
  return { kind: "retry", why: `exit ${s.code}, turn.completed=${s.sawCompleted}` };
}

export interface GeminiSignals {
  /** child exit code (null = killed by signal) */
  code: number | null;
  /** matched the usage/rate-limit heuristic on stdout or stderr */
  sawUsageLimit: boolean;
  /** the agy --print run actually produced output (non-empty stdout) */
  sawOutput: boolean;
  /** the node-side watchdog killed a hung turn */
  timedOut?: boolean;
}

/**
 * Antigravity (`agy --print`) has no structured completion marker — completion is a clean exit. But a
 * clean exit alone is NOT success: a usage cap or an empty turn can also exit 0, which would silently
 * "deliver" a message the agent never answered. So success requires exit 0 AND some printed output, and
 * a usage cap is held (not delivered) regardless of exit code.
 */
export function decideGeminiOutcome(s: GeminiSignals): ExecOutcome {
  if (s.sawUsageLimit) return { kind: "usage" };
  if (s.timedOut) return { kind: "retry", why: "turn watchdog timeout" };
  if (s.code === 0 && s.sawOutput) return { kind: "delivered" };
  if (s.code === 0) return { kind: "retry", why: "clean exit but no output (usage cap or empty turn)" };
  return { kind: "retry", why: `exit ${s.code}` };
}
