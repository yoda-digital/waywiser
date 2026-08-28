/**
 * gog CLI capability contract — runtime validation of required commands,
 * flags, and exit codes. Caches results by binary path + mtime + build.
 *
 * Blueprint §7: version is NOT the authority. The plugin verifies the
 * capability contract at runtime. We don't assume features based solely
 * on a gog version string.
 */
import * as fs from "node:fs";
import type { GogRunner } from "./gog-runner.js";

export interface GogContract {
	compatible: boolean;
	schemaVersion: number;
	build: string;
	missing: string[];
	commands: Set<string>;
	binaryPath: string;
}

interface GogSchema {
	schema_version: number;
	build: string;
	automation?: {
		exit_codes?: Record<string, unknown>;
		safety?: Record<string, unknown>;
	};
	command?: SchemaCommand;
}

interface SchemaCommand {
	name?: string;
	id?: string;
	path?: string;
	commands?: SchemaCommand[];
	subcommands?: SchemaCommand[];
	flags?: SchemaFlag[];
}

interface SchemaFlag {
	name?: string;
	long?: string;
}

// BUG-FIXED (2026-08-25): the full-root schema (`gog schema --json`) is
// ~5.9 MB on gog v0.37+ and exceeds the runner's 4 MB stdout cap →
// truncated JSON → "gog schema output is not valid JSON" → calendar tool
// permanently reported incompatible.
//
// FIX: validate against the TARGETED schema (`gog schema calendar --json`),
// ~240 KB. It is authoritative for every calendar.* command below and repeats
// the global flag set on the calendar node (verified on v0.37). Bare `schema`
// stays as fallback for older builds without per-command schemas (best effort).
// `schema` is always in the runner's exact-command allowlist.

// Required calendar commands (blueprint §7.1)
const REQUIRED_COMMANDS = [
	"calendar.calendars",
	"calendar.events",
	"calendar.event",
	"calendar.raw",
	"calendar.create",
	"calendar.update",
	"calendar.move",
	"calendar.delete",
	"calendar.freebusy",
	"calendar.respond",
	"calendar.colors",
	"calendar.conflicts",
	"calendar.changed",
	"calendar.search",
	"calendar.time",
	"calendar.focus-time",
	"calendar.out-of-office",
	"calendar.working-location",
	"calendar.subscribe",
	"calendar.unsubscribe",
	"calendar.create-calendar",
	"calendar.delete-calendar",
	"calendar.acl",
	"calendar.alias.list",
	"calendar.alias.set",
	"calendar.alias.unset",
	"calendar.propose-time",
	"calendar.users",
	"calendar.team",
];

// Required global safety flags
const REQUIRED_FLAGS = [
	"json",
	"no-input",
	"readonly",
	"wrap-untrusted",
	"enable-commands-exact",
	"dry-run",
];

/** Flatten command tree into a set of dotted command IDs. */
function flattenCommands(cmd: SchemaCommand, prefix = ""): string[] {
	const ids: string[] = [];
	const id = cmd.id || cmd.name || "";
	const fullId = prefix ? `${prefix}.${id}` : id;
	if (fullId) ids.push(fullId);
	const subs = [...(cmd.commands ?? []), ...(cmd.subcommands ?? [])];
	for (const sub of subs) {
		ids.push(...flattenCommands(sub, fullId));
	}
	return ids;
}

/** Extract flag long-names from a command's flags array. */
function extractFlagNames(cmd: SchemaCommand): string[] {
	const names: string[] = [];
	for (const f of cmd.flags ?? []) {
		if (f.long) names.push(f.long);
		else if (f.name) names.push(f.name);
	}
	return names;
}

let cachedContract: GogContract | undefined;
let cacheKey = "";

function buildCacheKey(binaryPath: string, mtime: number, build: string): string {
	return `${binaryPath}:${mtime}:${build}`;
}

function failContract(
	binaryPath: string,
	mtime: number,
	build: string,
	reason: string,
): GogContract {
	const contract: GogContract = {
		compatible: false,
		schemaVersion: -1,
		build,
		missing: [reason],
		commands: new Set(),
		binaryPath,
	};
	cacheKey = buildCacheKey(binaryPath, mtime, build);
	cachedContract = contract;
	return contract;
}

/**
 * Validate gog CLI capabilities via the targeted `gog schema calendar --json`
 * (fallback: bare `gog schema --json` for older builds).
 * Results are cached by binary path + mtime + build string.
 */
export async function validateContract(
	runner: GogRunner,
	binaryPath: string,
): Promise<GogContract> {
	// Check cache
	let mtime = 0;
	try {
		mtime = fs.statSync(binaryPath).mtimeMs;
	} catch { /* binary path might not be resolvable */ }

	if (cachedContract && cacheKey.startsWith(`${binaryPath}:${mtime}:`)) {
		return cachedContract;
	}

	// Prefer the small targeted schema (~240 KB on v0.37): parses under the cap.
	let result = await runner.run({
		command: ["schema", "calendar", "--json"],
		exactCommands: ["schema"],
		noInput: true,
		timeoutMs: 10_000,
	});
	if (result.exitCode !== 0) {
		// Older builds without per-command schemas: try the bare root schema
		// (best effort — may still exceed the cap on v0.37+; reported honestly).
		result = await runner.run({
			command: ["schema", "--json"],
			exactCommands: ["schema"],
			noInput: true,
			timeoutMs: 10_000,
		});
	}

	if (result.exitCode !== 0) {
		return failContract(binaryPath, mtime, "unknown", `gog schema command failed (exit ${result.exitCode})`);
	}

	let schema: GogSchema;
	try {
		schema = JSON.parse(result.stdout);
	} catch {
		return failContract(binaryPath, mtime, "unknown", "gog schema output is not valid JSON");
	}

	// Validate schema version
	if (schema.schema_version !== 1) {
		return failContract(
			binaryPath,
			mtime,
			schema.build ?? "unknown",
			`schema_version ${schema.schema_version} != 1`,
		);
	}

	const missing: string[] = [];

	// The command tree is identical in both schema shapes (root or targeted);
	// flatten it and normalize every ID to the contract form ("calendar.x").
	// Targeted shape: root node is "calendar", ids are sub-rendative
	// ("calendars", "alias.list"). Bare shape: root is the gog binary and the
	// calendar subtree has id "calendar" with the same children.
	const tree = schema.command ? flattenCommands(schema.command) : [];
	const commandSet = new Set<string>();
	for (const id of tree) {
		commandSet.add(id.startsWith("calendar.") || id === "calendar" ? id : `calendar.${id}`);
	}
	for (const req of REQUIRED_COMMANDS) {
		if (!commandSet.has(req)) missing.push(`command ${req}`);
	}

	// Global flags: on v0.37 the targeted schema repeats the full global flag
	// set on the calendar node. Extract from the command node.
	const globalFlags = extractFlagNames(schema.command ?? { flags: [] });
	const flagSet = new Set(globalFlags);
	for (const req of REQUIRED_FLAGS) {
		if (!flagSet.has(req)) missing.push(`global flag --${req}`);
	}

	const contract: GogContract = {
		compatible: missing.length === 0,
		schemaVersion: schema.schema_version,
		build: schema.build ?? "unknown",
		missing,
		commands: commandSet,
		binaryPath,
	};

	// Cache
	cacheKey = buildCacheKey(binaryPath, mtime, contract.build);
	cachedContract = contract;

	return contract;
}

/** Clear cached contract (for tests or after gog upgrade). */
export function clearContractCache(): void {
	cachedContract = undefined;
	cacheKey = "";
}
