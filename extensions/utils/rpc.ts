/**
 * waywiser-*rpc — shared Pi RPC (JSONL over stdio) client + small warm pool.
 *
 * Single canonical implementation of the `pi --mode rpc` protocol for all
 * waywiser consumers (delegate_task, execute_code).
 *
 * Protocol facts (verified against pi source, packages/coding-agent/src/modes/rpc/):
 * - strict JSONL over stdio: split on \n only, strip trailing \r (Node readline is
 *   NOT protocol-compliant: it splits on U+2028/U+2029). stdout is the protocol
 *   channel — never write to it from here.
 * - commands carry an `id`; a `{"type":"response", id}` line answers exactly one
 *   command. Everything else is an agent event; `agent_end` = current turn done.
 * - `new_session` under `--no-session`: honored, but it re-creates a PERSISTED
 *   session manager and re-runs session_start — treat as a heavy reset, and call
 *   it only defensively around clients that stay in the idle pool.
 *
 * Pool model (deliberately small, per-conversation personal agent):
 * - Lanes are keyed by the pi argv profile (leaf/orchestrator/execute_code spawn
 *   with different --extension flags; a client cannot serve another profile).
 * - Idle clients stay warm up to `maxIdle` (default 2) per lane, TTL-evicted
 *   (default 10 min). `acquire` never blocks on pool limits — the caller is the
 *   one that enforces concurrency caps (delegation.maxConcurrentChildren etc.).
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface PiRpcClient {
	/**
	 * Send a command; resolves with the `response` line. Rejects on timeout,
	 * stdin write failure, or child death.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	command<T = Record<string, unknown>>(cmd: Record<string, any>, timeoutMs?: number): Promise<T>;
	/** Resolve when the current turn emits `agent_end`. Rejects on timeout / death. */
	waitAgentEnd(timeoutMs: number): Promise<void>;
	/** Queue a steering message (delivered before the child's next LLM call). */
	steer(message: string): Promise<boolean>;
	/**
	 * Heavy reset: fresh (persisted) session + session_start re-run. Under
	 * --no-session this is safe but not free — only call before reusing an
	 * idle pool client (defensive; may drop extension state in orchestrator
	 * children, which is acceptable for backgrounded delegation).
	 */
	newSession(): Promise<void>;
	/** Final assistant message text ("" if none yet). */
	getLastAssistantText(timeoutMs?: number): Promise<string>;
	abort(): Promise<void>;
	/** True until the child process has exited. */
	isAlive(): boolean;
	/** Last ~4KB of child stderr (diagnostics only). */
	stderrTail(): string;
	/** Kill the child. Idempotent. */
	stop(): void;
}

export interface PoolAcquireOptions {
	/** Working directory for a freshly spawned client. */
	cwd?: string;
	/** Call newSession() on a reused idle client (default: true under this pool's model). */
	freshSession?: boolean;
	/** Max ms to allow for client startup (default 25000). */
	startupTimeoutMs?: number;
}

interface PoolLane {
	idle: Array<{ client: PiRpcClient; since: number; cwd: string }>;
	active: number;
	spawnQueued: number;
}

export interface PiRpcPool {
	/**
	 * Get a ready client: a warm idle one (optionally session-reset), or a
	 * freshly spawned one. Does NOT block on pool limits; `release` returns
	 * the client to the lane (warm) or kills it.
	 */
	acquire(profile: string, opts?: PoolAcquireOptions): Promise<PiRpcClient>;
	/** Return a client acquired from this pool profile to the idle set (or kill it). */
	release(profile: string, client: PiRpcClient): void;
	laneStats(profile: string): { idle: number; active: number };
	/** Kill every idle client. Safe to call on shutdown. */
	shutdownAll(): void;
}

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_STARTUP_TIMEOUT_MS = 25_000;
const STARTUP_PROBE_INTERVAL_MS = 1000;
const STARTUP_PROBE_MAX_ATTEMPTS = 25;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const IDLE_TTL_MS = 10 * 60_000;
const MAX_IDLE_PER_LANE = 2;

// ── Client ──────────────────────────────────────────────────────────────

interface Pending {
	resolve: (r: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export function createPiRpcClient(opts: { cwd: string; args: string[]; env?: NodeJS.ProcessEnv }): Promise<PiRpcClient> {
	const { cwd, args, env } = opts;
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn("pi", ["--mode", "rpc", ...args], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: env ?? process.env,
		});

		let buf = "";
		let stderr = "";
		let settled = false;
		let agentEnded = false;
		const pending = new Map<string, Pending>();
		const endWaiters: Array<() => void> = [];

		const die = (): void => {
			agentEnded = true;
			for (const w of endWaiters.splice(0)) w();
			for (const [, p] of pending) {
				clearTimeout(p.timer);
				p.reject(new Error("pi rpc child exited"));
			}
			pending.clear();
		};

		const readLine = (line: string): void => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(line);
			} catch {
				return; // tolerate stray diagnostics
			}
			if (msg.type === "response") {
				const id = typeof msg.id === "string" ? msg.id : undefined;
				if (id && pending.has(id)) {
					const p = pending.get(id)!;
					clearTimeout(p.timer);
					pending.delete(id);
					p.resolve(msg);
				}
				return;
			}
			if (msg.type === "agent_end") {
				agentEnded = true;
				for (const w of endWaiters.splice(0)) w();
				return;
			}
			if (msg.type === "agent_start") {
				agentEnded = false; // chained turns (prompt -> follow_up -> prompt) reset
			}
		};

		const pump = (chunk: string): void => {
			buf += chunk;
			for (;;) {
				const idx = buf.indexOf("\n");
				if (idx < 0) break;
				const line = buf.slice(0, idx).replace(/\r$/, "");
				buf = buf.slice(idx + 1);
				if (line.trim()) readLine(line);
			}
		};

		const stdinOk = (): boolean =>
			typeof child.stdin?.write === "function" && child.stdin.writable !== false;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const rpc: PiRpcClient = {
			command<T = Record<string, unknown>>(cmd: Record<string, any>, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS): Promise<T> {
				return new Promise((res, rej) => {
					const id = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
					const timer = setTimeout(() => {
						pending.delete(id);
						rej(new Error(`pi rpc command "${String((cmd as { type?: string }).type)}" timed out after ${timeoutMs}ms`));
					}, timeoutMs);
					pending.set(id, {
						resolve: (r) => res(r as T),
						reject: (e) => rej(e),
						timer,
					});
					try {
						if (!stdinOk()) throw new Error("child stdin not writable");
						child.stdin!.write(JSON.stringify({ ...cmd, id }) + "\n");
					} catch (e) {
						pending.delete(id);
						clearTimeout(timer);
						rej(e instanceof Error ? e : new Error(String(e)));
					}
				});
			},
			waitAgentEnd(timeoutMs: number): Promise<void> {
				return new Promise((res, rej) => {
					if (agentEnded) return res();
					const timer = setTimeout(() => {
						const i = endWaiters.indexOf(onEnd);
						if (i >= 0) endWaiters.splice(i, 1);
						rej(new Error(`agent turn did not finish within ${timeoutMs}ms`));
					}, timeoutMs);
					const onEnd = (): void => {
						clearTimeout(timer);
						res();
					};
					endWaiters.push(onEnd);
				});
			},
			steer(message: string): Promise<boolean> {
				return rpc
					.command({ type: "steer", message }, 10_000)
					.then((r) => r.success === true)
					.catch(() => false);
			},
			newSession(): Promise<void> {
				return rpc
					.command({ type: "new_session" }, 30_000)
					.then((r) => {
						if (r.success !== true) throw new Error(`new_session rejected: ${JSON.stringify(r).slice(0, 200)}`);
					});
			},
			async getLastAssistantText(timeoutMs: number = 10_000): Promise<string> {
				const r = await rpc.command<{ data?: { text?: string } }>({ type: "get_last_assistant_text" }, timeoutMs);
				return r.data?.text?.trim() ?? "";
			},
			async abort(): Promise<void> {
				await rpc.command({ type: "abort" }, 10_000).catch(() => undefined);
			},
			isAlive(): boolean {
				return child.exitCode === null && child.signalCode === null;
			},
			stderrTail(): string {
				return stderr;
			},
			stop(): void {
				try {
					if (child.exitCode === null) child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			},
		};

		child.stdout?.on("data", (d: Buffer) => pump(d.toString("utf-8")));
		child.stderr?.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString("utf-8")).slice(-4000);
		});
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			reject(new Error(`spawn pi: ${e.message}`));
		});
		child.on("close", () => {
			die();
			if (!settled) {
				// Early exit before the probe answered: child is dead, but resolve
				// so callers get graceful "child exited" command rejections rather
				// than a startup failure (startup errors are caught via probe timeout).
				settled = true;
				resolve(rpc);
			}
		});

		// Readiness probe: get_state round-trip (bounded retry for slow startup).
		const startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
		const probeTimer = setTimeout(() => {
			if (!settled) {
				settled = true;
				try {
					child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
				reject(new Error(`pi rpc startup timeout after ${startupTimeoutMs}ms${stderr ? `: ${stderr.slice(-300)}` : ""}`));
			}
		}, startupTimeoutMs);

		const attempt = (n: number): void => {
			if (settled) return;
			const id = `probe${n}`;
			pending.set(id, {
				resolve: () => {
					if (settled) return;
					settled = true;
					clearTimeout(probeTimer);
					resolve(rpc);
				},
				reject: () => undefined,
				timer: setTimeout(() => undefined, 0),
			});
			try {
				if (!stdinOk()) return;
				child.stdin!.write(JSON.stringify({ id, type: "get_state" }) + "\n");
			} catch {
				return;
			}
			if (n < STARTUP_PROBE_MAX_ATTEMPTS) {
				setTimeout(() => attempt(n + 1), STARTUP_PROBE_INTERVAL_MS);
			}
		};
		attempt(0);
	});
}

// ── Pool ────────────────────────────────────────────────────────────────

export interface PiRpcPoolOptions {
	/** Warm idle clients kept per lane (default 2, cap 4). */
	maxIdle?: number;
	/** Kill idle clients older than this (default 10 min). */
	idleTtlMs?: number;
	/** How to spawn a client for a lane + cwd. */
	spawn: (lane: string, cwd: string) => Promise<PiRpcClient>;
}

export function createPiRpcPool(opts: PiRpcPoolOptions): PiRpcPool {
	const maxIdle = Math.min(Math.max(opts.maxIdle ?? MAX_IDLE_PER_LANE, 0), 4);
	const idleTtlMs = Math.max(opts.idleTtlMs ?? IDLE_TTL_MS, 10_000);
	const lanes = new Map<string, PoolLane>();
	// Maps a handed-out client to pool bookkeeping (real client + cwd at acquire).
	const origin = new WeakMap<PiRpcClient, { client: PiRpcClient; cwd: string }>();

	/** Wrap a pool-owned client so release() can look it up via identity. */
	const wrap = (client: PiRpcClient, cwd: string): PiRpcClient => {
		const handle: PiRpcClient = {
			command: (c, t) => client.command(c, t),
			waitAgentEnd: (t) => client.waitAgentEnd(t),
			steer: (m) => client.steer(m),
			newSession: () => client.newSession(),
			getLastAssistantText: (t) => client.getLastAssistantText(t),
			abort: () => client.abort(),
			isAlive: () => client.isAlive(),
			stderrTail: () => client.stderrTail(),
			stop: () => client.stop(),
		};
		origin.set(handle, { client, cwd });
		return handle;
	};

	const lane = (profile: string): PoolLane => {
		let l = lanes.get(profile);
		if (!l) {
			l = { idle: [], active: 0, spawnQueued: 0 };
			lanes.set(profile, l);
		}
		// Opportunistic TTL eviction.
		const now = Date.now();
		for (let i = l.idle.length - 1; i >= 0; i--) {
			if (now - l.idle[i].since > idleTtlMs) {
				l.idle.splice(i, 1)[0].client.stop();
			}
		}
		return l;
	};

	return {
		async acquire(profile, acqOpts): Promise<PiRpcClient> {
			const l = lane(profile);
			const freshSession = acqOpts?.freshSession ?? true;
			const startupTimeoutMs = acqOpts?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
			const cwd = acqOpts?.cwd ?? process.cwd();

			// 1. Warm idle client with the SAME cwd (a client's cwd is fixed at spawn).
			if (maxIdle > 0) {
				const idx = l.idle.findIndex((e) => e.cwd === cwd);
				if (idx >= 0) {
					const [entry] = l.idle.splice(idx, 1);
					if (entry.client.isAlive()) {
						l.active += 1;
						if (freshSession) {
							// Heavy but only on reuse; never leak a dead client.
							await entry.client.newSession().catch(() => entry.client.stop());
						}
						if (entry.client.isAlive()) {
							return wrap(entry.client, cwd);
						}
						l.active -= 1; // died during reset -> fall through to spawn
					}
					else {
						entry.client.stop();
					}
				}
			}

			// 2. Fresh spawn (never blocks; concurrency caps belong to callers).
			l.spawnQueued += 1;
			try {
				const client = await opts.spawn(profile, cwd);
				l.active += 1;
				return wrap(client, cwd);
			} finally {
				l.spawnQueued -= 1;
			}
		},

		release(profile, handle): void {
			const l = lanes.get(profile);
			const o = origin.get(handle);
			// Release exactly once: a second release() of the same handle is a no-op.
			if (!o) {
				if (handle.isAlive()) handle.stop();
				return;
			}
			origin.delete(handle);
			if (l) l.active = Math.max(0, l.active - 1);
			const client = o.client;
			if (!client.isAlive()) {
				client.stop();
				return;
			}
			const laneFor = lane(profile);
			if (maxIdle > 0 && laneFor.idle.length < maxIdle) {
				laneFor.idle.push({ client, since: Date.now(), cwd: o.cwd });
			} else {
				client.stop();
			}
		},

		laneStats(profile): { idle: number; active: number } {
			const l = lanes.get(profile);
			return { idle: l?.idle.length ?? 0, active: (l?.active ?? 0) + (l?.spawnQueued ?? 0) };
		},

		shutdownAll(): void {
			for (const l of lanes.values()) {
				for (const e of l.idle.splice(0)) e.client.stop();
			}
		},
	};
}
