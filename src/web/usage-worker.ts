import { parentPort, workerData } from "node:worker_threads";
import { computeUsage } from "./usage.js";

/** Runs computeUsage off the main thread: it reads every agent's transcripts synchronously (~10 s) and must never block the engine's event loop. */
const { agents, cutoff } = workerData as { agents: Parameters<typeof computeUsage>[0]; cutoff: number };
parentPort!.postMessage(computeUsage(agents, cutoff));
