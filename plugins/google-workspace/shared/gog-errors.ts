/**
 * Semantic error model for gog CLI exit codes.
 *
 * Stable exit codes from gog are the authority for error classification.
 * Waywiser does not parse stderr for flow control when exit codes exist.
 *
 * Mapping (blueprint §22):
 *   0   → success
 *   2   → invalid_input
 *   3   → empty_results
 *   4   → auth_required
 *   5   → not_found
 *   6   → permission_denied
 *   7   → rate_limited
 *   8   → retryable
 *   10  → config
 *   130 → cancelled
 *   1   → unknown (generic fallback)
 */

export type CalendarErrorCode =
	| "success"
	| "auth_required"
	| "not_found"
	| "permission_denied"
	| "rate_limited"
	| "retryable"
	| "config"
	| "cancelled"
	| "invalid_input"
	| "empty_results"
	| "incompatible_adapter"
	| "malformed_adapter_output"
	| "timeout"
	| "ambiguous_write"
	| "unknown";

export interface CalendarError {
	code: CalendarErrorCode;
	message: string;
	exitCode?: number;
	stderr?: string;
}

const EXIT_CODE_MAP: Record<number, CalendarErrorCode> = {
	0: "success",
	2: "invalid_input",
	3: "empty_results",
	4: "auth_required",
	5: "not_found",
	6: "permission_denied",
	7: "rate_limited",
	8: "retryable",
	10: "config",
	130: "cancelled",
};

export function mapExitCode(exitCode: number): CalendarErrorCode {
	return EXIT_CODE_MAP[exitCode] ?? "unknown";
}

export function toCalendarError(exitCode: number, stderr: string): CalendarError {
	const code = mapExitCode(exitCode);
	const message = stderr.trim().split("\n")[0] || `gog exited with code ${exitCode}`;
	return { code, message, exitCode, stderr };
}

export function isRetryable(code: CalendarErrorCode): boolean {
	return code === "retryable" || code === "rate_limited";
}

export function isAuthError(code: CalendarErrorCode): boolean {
	return code === "auth_required" || code === "permission_denied";
}
