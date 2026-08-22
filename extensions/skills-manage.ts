/**
 * waywiser-*skills — skills_list / skill_view / skill_manage.
 * Skills live in ~/.waywiser/skills (discovered by pi as a package skill dir only
 * when passed via --skill/settings; to guarantee visibility without config, we
 * ALSO copy nothing — we expose them via tools and tell the model the path).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { waywiserHome, db_ } from "./utils/state.js";
import { registerInjection, removeInjection, PRIORITIES } from "./utils/prompt-budget.js";

interface SkillInfo {
	name: string;
	description: string;
	directory: string;
}

function skillsDirs(cwd: string): string[] {
	const dirs = [
		path.join(waywiserHome(), "skills"),
		path.join(cwd, ".pi", "skills"),
		path.join(process.env.HOME || ".", ".pi", "agent", "skills"),
		path.join(process.env.HOME || ".", ".agents", "skills"),
	];
	return [...new Set(dirs.map((d) => path.resolve(d)))];
}

function parseFrontmatter(content: string): [Record<string, string>, string] {
	const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) return [{}, content];
	const fm: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
		if (kv) fm[kv[1]] = kv[2].trim();
	}
	return [fm, m[2]];
}

function discoverSkills(cwd: string): SkillInfo[] {
	const found = new Map<string, SkillInfo>();
	for (const dir of skillsDirs(cwd)) {
		if (!fs.existsSync(dir)) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			// <dir>/<skill>/SKILL.md  or  <dir>/<skill>.md
			if (e.isDirectory()) {
				const file = path.join(dir, e.name, "SKILL.md");
				if (fs.existsSync(file)) {
					const [fm] = parseFrontmatter(fs.readFileSync(file, "utf-8"));
					found.set(fm.name || e.name, { name: fm.name || e.name, description: fm.description || "", directory: path.join(dir, e.name) });
				}
			} else if (e.name.endsWith(".md") && e.name !== "README.md") {
				const [fm] = parseFrontmatter(fs.readFileSync(path.join(dir, e.name), "utf-8"));
				found.set(fm.name || e.name.replace(/\.md$/, ""), { name: fm.name || e.name.replace(/\.md$/, ""), description: fm.description || "", directory: dir });
			}
		}
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const sanitize = (name: string): string => name.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "skill";

export default function skillsManage(pi: ExtensionAPI): void {
	// ── Inject lightweight PA skill catalog into system prompt ──────────
	// Progressive disclosure: only names + descriptions here (cache-stable).
	// Full skill content loads on-demand via skill_view.
	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		const skills = discoverSkills(ctx.cwd);
		const paSkills = skills.filter((s) => s.name.startsWith("pa-"));
		if (!paSkills.length) {
			removeInjection("pa-catalog");
			return {};
		}

		// Check if PA onboarding has been completed
		let onboarded = false;
		try {
			const row = db_().prepare("SELECT id FROM memories WHERE content LIKE '%PA system onboarded%' AND content LIKE '%pa-onboarded%' LIMIT 1").get();
			if (row) onboarded = true;
		} catch { /* db not ready yet — treat as not onboarded */ }

		// Tier badges: ✅ verified, ⚠️ experimental, 🔬 untested (default: experimental)
		const tierBadge = (s: SkillInfo): string => {
			try {
				const [fm] = parseFrontmatter(fs.readFileSync(path.join(s.directory, "SKILL.md"), "utf-8"));
				const tier = fm.model_tier ?? "experimental";
				return tier === "verified" ? "✅" : tier === "untested" ? "🔬" : "⚠️";
			} catch {
				return "⚠️";
			}
		};

		const catalog = paSkills
			.filter((s) => s.name !== "pa-onboard")
			.map((s) => `  ${tierBadge(s)} ${s.name}: ${s.description}`)
			.join("\n");

		// Auto-trigger onboarding on first-ever session
		if (!onboarded) {
			try {
				const memCount = (db_().prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
				if (memCount === 0) {
					// First-ever session: no memories at all → auto-trigger onboarding
					// The agent will greet the user and walk through setup
					try {
						pi.sendUserMessage(
							"[system] This is your first session. Load skill_view name=\"pa-onboard\" and run the complete setup wizard to configure Waywiser as your personal assistant. Greet the user warmly and walk them through each step.",
							{ deliverAs: "followUp" },
						);
					} catch { /* agent not ready yet — the note below will cover it */ }
				}
			} catch { /* db not ready */ }
		}

		const onboardNote = onboarded
			? ""
			: `\n⚠ PA system not yet onboarded. Run the setup wizard (automatic on first session,\n`
				+ `or invoke \`skill_view\` name="pa-onboard" manually). Sets up daily/weekly reviews,\n`
				+ `captures preferences, and creates the PA kanban board.\n`;

		registerInjection({
			key: "pa-catalog",
			priority: PRIORITIES.PA_CATALOG,
			cacheable: true, // stable within a session (skills don't change mid-session)
			content:
				`\n<!-- WAYWISER PLAYBOOKS (${paSkills.length} domains) -->\n`
				+ `When the user asks for help with personal assistant tasks (time management,\n`
				+ `writing, communication, research, events, finance, travel, decisions, etc.),\n`
				+ `use \`skill_view\` name="<playbook>" to load the relevant domain playbook, then follow it.\n`
				+ onboardNote
				+ `\nAvailable playbooks:\n${catalog}\n`
				+ `<!-- END PLAYBOOKS -->\n`,
		});
		// NO return of { systemPrompt: ... } — buildSystemPrompt handles assembly
		return {};
	});

	pi.registerTool({
		name: "skills_list",
		label: "Skills List",
		description: "List all discoverable skills (waywiser-*, project, and global pi skill dirs) with descriptions.",
		parameters: Type.Object({}),
		executionMode: "parallel",
		async execute(_id, _p, _signal, _update, ctx: ExtensionContext) {
			const skills = discoverSkills(ctx.cwd);
			if (!skills.length) return { content: [{ type: "text" as const, text: "No skills discovered." }], details: {} };
			return {
				content: [{ type: "text" as const, text: skills.map((s) => `- ${s.name}: ${s.description}  (${s.directory})`).join("\n") }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "skill_view",
		label: "Skill View",
		description: "Read the full SKILL.md content (instructions, references) of a skill by name.",
		parameters: Type.Object({
			name: Type.String({ description: "Skill name as listed by skills_list" }),
		}),
		executionMode: "parallel",
		async execute(_id, p, _signal, _update, ctx: ExtensionContext) {
			const skills = discoverSkills(ctx.cwd);
			const skill = skills.find((s) => s.name === p.name);
			if (!skill) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Skill "${p.name}" not found. Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`,
						},
					],
					details: {},
					isError: true,
				};
			}
			const file = fs.existsSync(path.join(skill.directory, "SKILL.md"))
				? path.join(skill.directory, "SKILL.md")
				: path.join(skill.directory, `${skill.name}.md`);
			try {
				return { content: [{ type: "text" as const, text: fs.readFileSync(file, "utf-8") }], details: {} };
			} catch (e) {
				return { content: [{ type: "text" as const, text: `Failed to read ${file}: ${String(e)}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "skill_manage",
		label: "Skill Manage",
		description:
			"Create/update/delete waywiser-* skills under ~/.waywiser/skills/<name>/SKILL.md. Creating a skill makes that capability discoverable in future sessions via skill_view / skills_list and pi skill discovery once the dir is configured.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]),
			name: Type.String({ description: "Skill name (kebab-case)" }),
			description: Type.Optional(Type.String({ description: "When to use this skill (model-visible)" })),
			content: Type.Optional(Type.String({ description: "Full SKILL.md body (without frontmatter)" })),
		}),
		executionMode: "sequential",
		async execute(_id, p, _signal, _update, _ctx: ExtensionContext) {
			const name = sanitize(p.name);
			const dir = path.join(waywiserHome(), "skills", name);
			const file = path.join(dir, "SKILL.md");
			if (p.action === "delete") {
				if (!fs.existsSync(dir)) return { content: [{ type: "text" as const, text: `No skill "${name}" to delete` }], details: {}, isError: true };
				fs.rmSync(dir, { recursive: true, force: true });
				return { content: [{ type: "text" as const, text: `Deleted skill "${name}"` }], details: {} };
			}
			if (!p.content?.trim()) return { content: [{ type: "text" as const, text: `${p.action} requires content` }], details: {}, isError: true };
			if (p.action === "create" && fs.existsSync(file)) {
				return { content: [{ type: "text" as const, text: `Skill "${name}" already exists at ${file}. Use action=update to replace.` }], details: {}, isError: true };
			}
			const existing = fs.existsSync(file) ? parseFrontmatter(fs.readFileSync(file, "utf-8"))[0] : {};
			const description = p.description ?? existing.description ?? "Waywiser skill (create it with a description)";
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${p.content.trim()}\n`);
			return { content: [{ type: "text" as const, text: `Skill "${name}" ${p.action}d at ${file}` }], details: {} };
		},
	});
}
