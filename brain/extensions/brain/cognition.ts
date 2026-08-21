import { spawn, type ChildProcess } from "node:child_process";
import type { BrainConfig } from "./types.ts";

interface ActiveWorker {
  process: ChildProcess;
  lane: string;
  startedAt: number;
}

export interface CognitionPool {
  /**
   * Run a prompt through a Pi meta-worker.
   * lane is for logging/identification only — all lanes use the same spawn mechanism.
   */
  run(lane: string, prompt: { system: string; user: string }, timeoutMs?: number): Promise<string>;

  /** Convenience methods for specific lanes */
  runLearner(prompt: { system: string; user: string }, timeoutMs?: number): Promise<string>;
  runConsolidation(prompt: { system: string; user: string }, timeoutMs?: number): Promise<string>;
  runSkillCompiler(prompt: { system: string; user: string }, timeoutMs?: number): Promise<string>;
  runJudge(prompt: { system: string; user: string }, timeoutMs?: number): Promise<string>;

  /** Kill any running workers and clean up */
  shutdown(): void;
}

export function createCognitionPool(config: BrainConfig): CognitionPool {
  const activeWorkers: Set<ActiveWorker> = new Set();
  let shuttingDown = false;

  async function run(
    lane: string,
    prompt: { system: string; user: string },
    timeoutMs: number = config.learning.gateTimeoutMs,
  ): Promise<string> {
    if (shuttingDown) throw new Error("cognition pool is shut down");

    const args = [
      "--print",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--system-prompt", prompt.system,
    ];

    // Add model override if configured
    if (config.cognition.model) {
      args.push("--model", config.cognition.model);
    }

    // Add thinking level if configured
    if (config.cognition.thinkingLevel) {
      args.push("--thinking", config.cognition.thinkingLevel);
    }

    return new Promise<string>((resolve, reject) => {
      const child = spawn("pi", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      const worker: ActiveWorker = { process: child, lane, startedAt: Date.now() };
      activeWorkers.add(worker);

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf-8")).slice(-2000);
      });

      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        activeWorkers.delete(worker);
        reject(new Error(`cognition ${lane}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        activeWorkers.delete(worker);

        if (code !== 0 && !stdout.trim()) {
          reject(new Error(
            `cognition ${lane}: pi exited with code ${code}${stderr ? `: ${stderr.slice(-300)}` : ""}`
          ));
          return;
        }

        resolve(stdout.trim());
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        activeWorkers.delete(worker);
        reject(new Error(`cognition ${lane}: spawn error: ${err.message}`));
      });

      // Send user prompt on stdin then close it
      if (child.stdin) {
        child.stdin.write(prompt.user);
        child.stdin.end();
      }
    });
  }

  return {
    run,
    runLearner: (prompt, timeout) => run("learn", prompt, timeout),
    runConsolidation: (prompt, timeout) => run("consolidate", prompt, timeout),
    runSkillCompiler: (prompt, timeout) => run("compile-skill", prompt, timeout),
    runJudge: (prompt, timeout) => run("judge", prompt, timeout),

    shutdown() {
      shuttingDown = true;
      for (const worker of activeWorkers) {
        try { worker.process.kill("SIGKILL"); } catch { /* already dead */ }
      }
      activeWorkers.clear();
    },
  };
}
