/**
 * Invocation builder — constructs the gog CLI argv from an operation
 * spec, resolved account, and operation-specific arguments.
 *
 * Blueprint §14 defense-in-depth layers:
 * 1. Model cannot construct argv
 * 2. Operation manifest chooses the single command
 * 3. --enable-commands-exact limits command surface
 * 4. --readonly blocks HTTP mutations
 * 5. --no-input prevents prompt/browser surprises
 * 6. --wrap-untrusted marks free text extern
 * 7. JSON is the output protocol
 * 8. Waywiser normalization doesn't deliver raw stdout as instruction
 *
 * --enable-commands=calendar is intentionally avoided because it
 * enables write commands too.
 */
import type { GogInvocation } from "../../shared/gog-runner.js";
import type { CalendarOperationSpec } from "./types.js";

/**
 * Build a safe, fully-specified gog invocation from an operation spec.
 *
 * @param spec   - The operation spec from the manifest
 * @param account - Resolved account email (or undefined for auth-free ops)
 * @param operationArgs - Operation-specific args (calendar ID, event ID, flags, etc.)
 * @param opts - Optional overrides (dryRun, signal, timeoutMs)
 */
export function buildGogInvocation(
	spec: CalendarOperationSpec,
	account: string | undefined,
	operationArgs: string[],
	opts?: { dryRun?: boolean; signal?: AbortSignal; timeoutMs?: number },
): GogInvocation {
	const args: string[] = [];

	// Account — every invocation with auth gets explicit account
	if (account) {
		args.push("--account", account);
	}

	// Command restriction: exact allowlist (schema always included for readiness)
	args.push(`--enable-commands-exact=schema,${spec.exactCommand}`);

	// Safety flags
	if (spec.readonly) args.push("--readonly");
	args.push("--no-input");
	if (spec.wrapUntrusted) args.push("--wrap-untrusted");

	// Dry-run (for write validation pass)
	if (opts?.dryRun && spec.supportsDryRun) {
		args.push("--dry-run");
	}

	// Output format
	args.push("--json");

	// The actual gog command segments
	args.push(...spec.gogCommand);

	// Operation-specific arguments
	args.push(...operationArgs);

	return {
		command: args,
		account,
		readonly: spec.readonly,
		noInput: true,
		wrapUntrusted: spec.wrapUntrusted,
		dryRun: opts?.dryRun,
		exactCommands: ["schema", spec.exactCommand],
		timeoutMs: opts?.timeoutMs ?? spec.timeoutMs,
		signal: opts?.signal,
	};
}
