/**
 * GogRunner — subprocess boundary for gog CLI invocations.
 *
 * Production implementation spawns gog with shell:false, sanitized env,
 * stdout/stderr caps, timeout, and abort support. FakeGogRunner provides
 * deterministic canned responses for tests.
 *
 * Invariants (blueprint §6):
 * - Never shell: true
 * - Never command string concatenation
 * - Never model-supplied flags arbitrarily
 * - No --access-token from tool input
 * - No --home arbitrarily
 * - Account resolved by plugin
 * - stdout/stderr capped
 * - Timeout per operation
 * - Abort kills process tree
 * - JSON parse failure → semantic error
 * - Exit codes are authority for classification
 */
import { spawn } from "node:child_process";

export interface GogInvocation {
	command: string[];
	account?: string;
	readonly?: boolean;
	noInput?: boolean;
	wrapUntrusted?: boolean;
	dryRun?: boolean;
	exactCommands: string[];
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface GogResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface GogRunner {
	run(invocation: GogInvocation): Promise<GogResult>;
}

const DEFAULT_STDOUT_CAP = 4 * 1024 * 1024; // 4 MB
const DEFAULT_STDERR_CAP = 256 * 1024; // 256 KB

export class ProductionGogRunner implements GogRunner {
	private readonly binary: string;
	private readonly stdoutCap: number;
	private readonly stderrCap: number;

	constructor(opts?: { binary?: string; stdoutCap?: number; stderrCap?: number }) {
		this.binary = opts?.binary ?? "gog";
		this.stdoutCap = opts?.stdoutCap ?? DEFAULT_STDOUT_CAP;
		this.stderrCap = opts?.stderrCap ?? DEFAULT_STDERR_CAP;
	}

	async run(invocation: GogInvocation): Promise<GogResult> {
		const start = Date.now();

		return new Promise<GogResult>((resolve, reject) => {
			const child = spawn(this.binary, invocation.command, {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: this.sanitizedEnv(),
			});

			let stdout = "";
			let stderr = "";
			let stdoutCapped = false;
			let stderrCapped = false;
			let killed = false;

			child.stdout!.on("data", (chunk: Buffer) => {
				if (stdoutCapped) return;
				stdout += chunk.toString();
				if (stdout.length > this.stdoutCap) {
					stdout = stdout.slice(0, this.stdoutCap);
					stdoutCapped = true;
				}
			});

			child.stderr!.on("data", (chunk: Buffer) => {
				if (stderrCapped) return;
				stderr += chunk.toString();
				if (stderr.length > this.stderrCap) {
					stderr = stderr.slice(0, this.stderrCap);
					stderrCapped = true;
				}
			});

			// Timeout
			const timer = setTimeout(() => {
				killed = true;
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 3000);
			}, invocation.timeoutMs);

			// Abort signal
			if (invocation.signal) {
				const onAbort = () => {
					killed = true;
					child.kill("SIGTERM");
					setTimeout(() => child.kill("SIGKILL"), 3000);
				};
				if (invocation.signal.aborted) {
					onAbort();
				} else {
					invocation.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.on("error", (err) => {
				clearTimeout(timer);
				reject(new Error(`Failed to spawn gog: ${err.message}`));
			});

			child.on("close", (code) => {
				clearTimeout(timer);
				const exitCode = killed ? 130 : (code ?? 1);
				resolve({
					exitCode,
					stdout,
					stderr,
					durationMs: Date.now() - start,
				});
			});
		});
	}

	private sanitizedEnv(): Record<string, string | undefined> {
		const env = { ...process.env };
		// Remove potentially dangerous env vars — never pass tokens from tool input
		delete env.GOG_ACCESS_TOKEN;
		return env;
	}
}

/** Deterministic test runner with canned responses. */
export class FakeGogRunner implements GogRunner {
	public invocations: GogInvocation[] = [];
	private responses: Map<string, GogResult> = new Map();
	private defaultResponse: GogResult = {
		exitCode: 0,
		stdout: "{}",
		stderr: "",
		durationMs: 10,
	};

	setResponse(commandKey: string, response: GogResult): void {
		this.responses.set(commandKey, response);
	}

	setDefaultResponse(response: GogResult): void {
		this.defaultResponse = response;
	}

	async run(invocation: GogInvocation): Promise<GogResult> {
		this.invocations.push(invocation);
		const key = invocation.command.join(" ");
		return this.responses.get(key) ?? this.defaultResponse;
	}
}
