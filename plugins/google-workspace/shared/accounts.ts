/**
 * Account routing for Google Workspace operations.
 *
 * Waywiser does NOT store OAuth tokens. gog manages its own keyring/
 * credential store. Waywiser only knows which accounts are configured
 * and routes operations to the right one.
 *
 * Resolution order (blueprint §9):
 * 1. Explicit account from tool input
 * 2. Account alias lookup
 * 3. Configured default
 * 4. If exactly one usable account → use it
 * 5. Otherwise → account_required error
 *
 * Every gog invocation gets an explicit `--account resolved@example.com`.
 * We never depend on "whatever gog considers default" in an autonomous agent.
 */
import * as path from "node:path";
import { waywiserHome, readJSON } from "../../../extensions/utils/state.js";

export interface GoogleAccount {
	email: string;
	alias?: string;
	default?: boolean;
}

export interface GoogleWorkspaceConfig {
	gogBinary: string;
	accounts: GoogleAccount[];
	calendar: CalendarConfig;
}

export interface CalendarConfig {
	defaultCalendar: string;
	timeouts: {
		readMs: number;
		writeMs: number;
		schemaMs: number;
		authCheckMs: number;
	};
	limits: {
		stdoutBytes: number;
		stderrBytes: number;
		multiAccountConcurrency: number;
		maxPageResults: number;
	};
	projection: {
		enabled: boolean;
		pastHours: number;
		futureDays: number;
		refreshMinutes: number;
		staleAfterMinutes: number;
	};
	safety: {
		wrapUntrustedReads: boolean;
		exactCommandAllowlist: boolean;
		readonlyReads: boolean;
		dryRunWrites: boolean;
	};
}

const DEFAULT_CONFIG: GoogleWorkspaceConfig = {
	gogBinary: "gog",
	accounts: [],
	calendar: {
		defaultCalendar: "primary",
		timeouts: { readMs: 30_000, writeMs: 30_000, schemaMs: 10_000, authCheckMs: 15_000 },
		limits: { stdoutBytes: 4_194_304, stderrBytes: 262_144, multiAccountConcurrency: 4, maxPageResults: 2500 },
		projection: { enabled: true, pastHours: 24, futureDays: 14, refreshMinutes: 15, staleAfterMinutes: 45 },
		safety: { wrapUntrustedReads: true, exactCommandAllowlist: true, readonlyReads: true, dryRunWrites: true },
	},
};

export function loadGoogleWorkspaceConfig(): GoogleWorkspaceConfig {
	const file = path.join(waywiserHome(), "google-workspace.json");
	const raw = readJSON<Partial<GoogleWorkspaceConfig>>(file, {});
	return {
		gogBinary: raw.gogBinary ?? DEFAULT_CONFIG.gogBinary,
		accounts: raw.accounts ?? DEFAULT_CONFIG.accounts,
		calendar: {
			defaultCalendar: raw.calendar?.defaultCalendar ?? DEFAULT_CONFIG.calendar.defaultCalendar,
			timeouts: { ...DEFAULT_CONFIG.calendar.timeouts, ...raw.calendar?.timeouts },
			limits: { ...DEFAULT_CONFIG.calendar.limits, ...raw.calendar?.limits },
			projection: { ...DEFAULT_CONFIG.calendar.projection, ...raw.calendar?.projection },
			safety: { ...DEFAULT_CONFIG.calendar.safety, ...raw.calendar?.safety },
		},
	};
}

export type AccountResolution =
	| { resolved: true; email: string }
	| { resolved: false; reason: "account_required" | "unknown_alias" | "no_accounts"; message: string };

/**
 * Resolve account for a calendar operation.
 * For writes: exactly one account required.
 * For reads: can return resolved account or use all configured.
 */
export function resolveAccount(
	config: GoogleWorkspaceConfig,
	explicitAccount?: string,
): AccountResolution {
	if (!config.accounts.length) {
		return {
			resolved: false,
			reason: "no_accounts",
			message: "No Google accounts configured. Add accounts to ~/.waywiser/google-workspace.json.",
		};
	}

	// 1. Explicit account (email or alias)
	if (explicitAccount) {
		const byEmail = config.accounts.find((a) => a.email === explicitAccount);
		if (byEmail) return { resolved: true, email: byEmail.email };

		const byAlias = config.accounts.find((a) => a.alias === explicitAccount);
		if (byAlias) return { resolved: true, email: byAlias.email };

		return {
			resolved: false,
			reason: "unknown_alias",
			message: `Unknown account or alias: "${explicitAccount}". Configured: ${config.accounts.map((a) => (a.alias ? `${a.email} (${a.alias})` : a.email)).join(", ")}`,
		};
	}

	// 2. Configured default
	const defaultAccount = config.accounts.find((a) => a.default);
	if (defaultAccount) return { resolved: true, email: defaultAccount.email };

	// 3. Exactly one account — use it
	if (config.accounts.length === 1) return { resolved: true, email: config.accounts[0].email };

	// 4. Ambiguous
	return {
		resolved: false,
		reason: "account_required",
		message: `Multiple accounts configured but none marked default. Specify account explicitly. Configured: ${config.accounts.map((a) => (a.alias ? `${a.email} (${a.alias})` : a.email)).join(", ")}`,
	};
}
