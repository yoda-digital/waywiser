// test/e2e/helpers.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAYWISER_ROOT = path.resolve(HERE, "../..");

export function createTestHome(): { home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "ww-e2e-"));
	// Bootstrap SOUL.md so the session starts cleanly.
	fs.copyFileSync(
		path.join(WAYWISER_ROOT, "config/SOUL.md"),
		path.join(home, "SOUL.md")
	);
	fs.writeFileSync(path.join(home, "MEMORY.md"), "");
	fs.writeFileSync(path.join(home, "USER.md"), "");
	return {
		home,
		cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
	};
}

export function requireModel(): void {
	if (!process.env.WAYWISER_E2E_MODEL) {
		throw new Error(
			"WAYWISER_E2E_MODEL not set — skipping e2e test (set to a model id, e.g. qwen3:8b)"
		);
	}
}

export const EXTENSION_PATH = path.join(WAYWISER_ROOT, "extensions/index.ts");
export const SKILL_PATH = path.join(WAYWISER_ROOT, "skills/waywiser/SKILL.md");
