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

// Required calendar commands (blueprint §7.1)
const REQUIRED_COMMANDS = [
	"schema",
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

/** Extract global flag long-names from root command. */
function extractGlobalFlags(cmd: SchemaCommand): string[] {
	const flags: string[] = [];
	for (const f of cmd.flags ?? []) {
		if (f.long) flags.push(f.long);
		else if (f.name) flags.push(f.name);
	}
	return flags;
}

let cachedContract: GogContract | undefined;
let cacheKey = "";

function buildCacheKey(binaryPath: string, mtime: number, build: string): string {
	return `${binaryPath}:${mtime}:${build}`;
}

/**
 * Validate gog CLI capabilities by running `gog schema --json`.
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

	const result = await runner.run({
		command: ["schema", "--json"],
		exactCommands: ["schema"],
		noInput: true,
		timeoutMs: 10_000,
	});

	if (result.exitCode !== 0) {
		return {
			compatible: false,
			schemaVersion: -1,
			build: "unknown",
			missing: ["gog schema command failed"],
			commands: new Set(),
			binaryPath,
		};
	}

	let schema: GogSchema;
	try {
		schema = JSON.parse(result.stdout);
	} catch {
		return {
			compatible: false,
			schemaVersion: -1,
			build: "unknown",
			missing: ["gog schema output is not valid JSON"],
			commands: new Set(),
			binaryPath,
		};
	}

	// Validate schema version
	if (schema.schema_version !== 1) {
		return {
			compatible: false,
			schemaVersion: schema.schema_version,
			build: schema.build ?? "unknown",
			missing: [`schema_version ${schema.schema_version} != 1`],
			commands: new Set(),
			binaryPath,
		};
	}

	const missing: string[] = [];

	// Validate commands (root-relative IDs, e.g. "calendar.events" and "schema")
	const rootCommand = schema.command;
	const allCommands = rootCommand
		? [...(rootCommand.commands ?? []), ...(rootCommand.subcommands ?? [])].flatMap((sub) =>
				flattenCommands(sub, ""),
		  )
		: [];
	const commandSet = new Set(allCommands);
	for (const req of REQUIRED_COMMANDS) {
		if (!commandSet.has(req)) missing.push(`command ${req}`);
	}

	// Validate global flags
	const globalFlags = schema.command ? extractGlobalFlags(schema.command) : [];
	const flagSet = new Set(globalFlags);
	for (const req of REQUIRED_FLAGS) {
		if (!flagSet.has(req)) {
			missing.push(`global flag --${req}`);
		}
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
