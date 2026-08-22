/**
 * waywiser-*mcp — MCP (Model Context Protocol) loader.
 *
 * Reads ~/.waywiser/mcp.json, spawns each enabled MCP server over stdio,
 * discovers its tools via the MCP JSON-RPC 2.0 handshake, and registers each
 * discovered tool as a pi tool named "<server>__<tool>". No servers
 * configured -> this extension is a silent no-op (nothing to connect to).
 *
 * Protocol (stdio transport): newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * initialize -> notifications/initialized (fire-and-forget) -> tools/list ->
 * tools/call per invocation. No explicit shutdown method: close stdin and
 * send SIGTERM.
 *
 * Line-buffering follows the same discipline as ./utils/rpc.ts (the pi child
 * RPC client): split strictly on "\n", strip a trailing "\r", tolerate
 * partial reads split across data events, tolerate stray non-JSON lines.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { waywiserHome, readJSON } from "./utils/state.js";

interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	enabled?: boolean;
}

interface McpConfig {
	servers: Record<string, McpServerConfig>;
}

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface McpContentItem {
	type: string;
	text?: string;
}

const CALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_RESTARTS = 3;

interface Pending {
	resolve: (v: Record<string, unknown>) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** One MCP server connection: spawn, JSON-RPC 2.0 over stdio, tool discovery + calls. */
class McpClient {
	private proc: ChildProcess | undefined;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private buf = "";
	private stderrTail = "";
	private tools: McpTool[] = [];
	private restarts = 0;
	private dead = true;

	constructor(
		private readonly name: string,
		private readonly config: McpServerConfig,
	) {}

	/** Spawn the server, run the initialize handshake, and discover its tools. */
	async connect(): Promise<McpTool[]> {
		await this.spawnProcess();
		await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "waywiser", version: "1.0.0" },
		}, CONNECT_TIMEOUT_MS);
		this.notify("notifications/initialized", {});
		const result = await this.request<{ tools?: McpTool[] }>("tools/list", {}, CONNECT_TIMEOUT_MS);
		this.tools = Array.isArray(result.tools) ? result.tools : [];
		return this.tools;
	}

	/** Call a tool by its MCP name (not the pi-prefixed name). */
	async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
		if (!this.isAlive()) {
			await this.reconnect();
		}
		const result = await this.request<{ content?: McpContentItem[]; isError?: boolean }>(
			"tools/call",
			{ name: toolName, arguments: args },
			CALL_TIMEOUT_MS,
		);
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("\n");
		if (text) return text;
		return result.isError ? "MCP tool reported an error with no message." : "(empty result)";
	}

	isAlive(): boolean {
		return !this.dead && this.proc !== undefined && this.proc.exitCode === null;
	}

	toolCount(): number {
		return this.tools.length;
	}

	shutdown(): void {
		const proc = this.proc;
		this.proc = undefined;
		this.markDead(new Error(`mcp "${this.name}" shut down`));
		if (!proc) return;
		try {
			proc.stdin?.end();
		} catch {
			/* already closed */
		}
		try {
			if (proc.exitCode === null) proc.kill("SIGTERM");
		} catch {
			/* already dead */
		}
	}

	// ── internals ──────────────────────────────────────────────────────

	private spawnProcess(): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let proc: ChildProcess;
			try {
				proc = spawn(this.config.command, this.config.args ?? [], {
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...process.env, ...(this.config.env ?? {}) },
				});
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}
			this.proc = proc;
			this.dead = false;
			this.buf = "";

			proc.stdout?.on("data", (chunk: Buffer) => this.pump(chunk.toString("utf-8")));
			proc.stderr?.on("data", (chunk: Buffer) => {
				this.stderrTail = (this.stderrTail + chunk.toString("utf-8")).slice(-4000);
			});
			proc.once("error", (err) => {
				const e = err instanceof Error ? err : new Error(String(err));
				this.markDead(e);
				if (!settled) {
					settled = true;
					reject(e);
				}
			});
			proc.once("exit", (code, signal) => {
				const e = new Error(
					`mcp server "${this.name}" exited (code=${code ?? "null"}, signal=${signal ?? "null"})${this.stderrTail ? `: ${this.stderrTail.slice(-300)}` : ""}`,
				);
				this.markDead(e);
				if (!settled) {
					settled = true;
					reject(e);
				}
			});
			// There is no explicit "spawned" signal in node:child_process; a
			// synchronous spawn() call that doesn't throw is treated as success.
			// A subsequent immediate 'error'/'exit' still surfaces correctly:
			// markDead() runs first and request() below checks `this.dead`
			// before registering a pending entry, so it rejects immediately
			// instead of waiting out the full connect timeout.
			settled = true;
			resolve();
		});
	}

	private pump(chunk: string): void {
		this.buf += chunk;
		if (this.buf.length > 1_000_000) {
			this.buf = this.buf.slice(-100_000);
		}
		for (;;) {
			const idx = this.buf.indexOf("\n");
			if (idx < 0) break;
			const line = this.buf.slice(0, idx).replace(/\r$/, "");
			this.buf = this.buf.slice(idx + 1);
			if (line.trim()) this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line);
		} catch {
			return; // some MCP servers stray-log to stdout; tolerate non-JSON lines
		}
		const id = msg.id;
		if (typeof id !== "number" || !this.pending.has(id)) return; // notification / unmatched — ignore
		const p = this.pending.get(id)!;
		this.pending.delete(id);
		clearTimeout(p.timer);
		if (msg.error) {
			const err = msg.error as { message?: string; code?: number };
			p.reject(new Error(`mcp "${this.name}" error ${err.code ?? "?"}: ${err.message ?? "unknown"}`));
			return;
		}
		p.resolve((msg.result as Record<string, unknown>) ?? {});
	}

	private markDead(err: Error): void {
		if (this.dead) return;
		this.dead = true;
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	private request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
		if (this.dead) return Promise.reject(new Error(`mcp "${this.name}" is not connected`));
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`mcp "${this.name}" request "${method}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
			try {
				this.write({ jsonrpc: "2.0", id, method, params });
			} catch (e) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	private notify(method: string, params: Record<string, unknown>): void {
		try {
			this.write({ jsonrpc: "2.0", method, params });
		} catch {
			/* fire-and-forget */
		}
	}

	private write(msg: Record<string, unknown>): void {
		if (!this.proc?.stdin?.writable) throw new Error(`mcp "${this.name}" stdin not writable`);
		this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	private async reconnect(): Promise<void> {
		if (this.restarts >= MAX_RESTARTS) {
			throw new Error(`mcp "${this.name}" exceeded ${MAX_RESTARTS} restart attempts; not retrying`);
		}
		this.restarts += 1;
		this.shutdown();
		await this.connect();
		this.restarts = 0; // reset after successful reconnect
	}
}

export default function mcp(pi: ExtensionAPI): void {
	const configFile = path.join(waywiserHome(), "mcp.json");
	const config = readJSON<McpConfig>(configFile, { servers: {} });
	const entries = Object.entries(config.servers ?? {}).filter(([, c]) => c.enabled !== false);
	if (!entries.length) return; // no servers configured — skip silently

	const clients = new Map<string, McpClient>();
	for (const [name, serverConfig] of entries) {
		clients.set(name, new McpClient(name, serverConfig));
	}

	// Lazy connect: real spawn + discovery happens once, on the first
	// before_agent_start, so an idle session never pays the MCP startup cost.
	let initialized = false;
	pi.on("before_agent_start", async () => {
		if (initialized) return;
		initialized = true;

		for (const [name, client] of clients) {
			try {
				const tools = await client.connect();
				for (const tool of tools) {
					const piToolName = `${name}__${tool.name}`;
					pi.registerTool({
						name: piToolName,
						label: `MCP: ${name}/${tool.name}`,
						description: `[MCP:${name}] ${tool.description || tool.name}`,
						// MCP inputSchema is already JSON-Schema shaped (type/properties/…),
						// and TypeBox schemas are structurally JSON Schema at runtime, so this
						// satisfies pi's actual runtime contract even though it isn't built
						// through Type.Object(). Falls back to a no-arg schema when absent.
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						parameters: (tool.inputSchema as any) ?? Type.Object({}),
						executionMode: "sequential",
						async execute(_id, params) {
							try {
								const text = await client.callTool(tool.name, params as Record<string, unknown>);
								return { content: [{ type: "text" as const, text }], details: {} };
							} catch (err) {
								const text = `MCP error (${name}/${tool.name}): ${err instanceof Error ? err.message : String(err)}`;
								return { content: [{ type: "text" as const, text }], details: {}, isError: true };
							}
						},
					});
				}
				process.stderr.write(`waywiser/mcp: ${name} connected — ${tools.length} tool(s)\n`);
			} catch (err) {
				process.stderr.write(`waywiser/mcp: ${name} failed to connect: ${err instanceof Error ? err.message : String(err)}\n`);
			}
		}
	});

	pi.registerCommand("mcp", {
		description: "Show MCP server status and registered tools (config: ~/.waywiser/mcp.json)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!clients.size) {
				ctx.ui.notify("No MCP servers configured. Add servers to ~/.waywiser/mcp.json (see config/mcp.example.json).", "info");
				return;
			}
			const lines = [...clients.entries()].map(([name, client]) => {
				const status = !initialized ? "not yet started" : client.isAlive() ? "connected" : "disconnected";
				return `**${name}**: ${status} — ${client.toolCount()} tool(s)`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_shutdown", () => {
		for (const [, client] of clients) client.shutdown();
	});
}
