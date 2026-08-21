/**
 * waywiser-brain — vault (markdown projection + Obsidian-compatible sync).
 *
 * Projects Brain's SQLite state (active memories, non-retired procedures)
 * to human-readable markdown files with YAML frontmatter under
 * `config.markdownRoot`, and syncs human edits made to those files back
 * into the database. There is no filesystem watcher — sync only happens
 * at session boundaries:
 *
 *   - `vaultSyncInbound`  — called at session_start. Compares each tracked
 *     file's current content hash against the hash recorded the last time
 *     Brain wrote it. A mismatch means a human edited the file since, so
 *     the file's content is imported into the DB as user-authoritative
 *     (`source = 'user'`) — this is the "human wins" conflict policy.
 *   - `vaultSyncOutbound` — called at session_shutdown. Renders every
 *     active memory and non-retired procedure to markdown and writes it
 *     only if the rendered content's hash differs from what's already on
 *     disk (tracked via `vault_sync`), so an unmodified file's mtime never
 *     changes.
 *
 * `vault_sync` (see store.ts) is the single source of truth linking a
 * file path to the memory/procedure it was rendered from and the hash of
 * what Brain last wrote — both directions of sync consult and update it.
 *
 * Obsidian-native features (activated when a RenderContext is passed):
 * typed Properties (tag arrays, cssclasses, aliases), callout blocks for
 * status, wikilinks between memories and procedures, mermaid evidence
 * chain diagrams, MOC (Map of Content) index files, and a brain overview
 * canvas.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { BrainMemory, Procedure, BrainConfig } from "./types.ts";
import type { BrainStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Deterministic content hash used for change detection (not security). */
export function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/** Generates a filesystem-safe slug from a memory's type and content. */
export function memorySlug(mem: BrainMemory): string {
  const prefix = mem.type;
  const body = mem.content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${prefix}-${body || mem.id}`;
}

/** Generates a filesystem-safe slug from a procedure's key. */
export function procedureSlug(proc: Procedure): string {
  const slug = proc.key
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return slug || proc.id;
}

// ---------------------------------------------------------------------------
// Render context (optional rich data for Obsidian-native features)
// ---------------------------------------------------------------------------

/** When passed to render functions, activates Obsidian-native output:
 *  typed Properties, callout blocks, wikilinks, mermaid diagrams. */
export interface RenderContext {
  evidenceIds: string[];
  relatedProcedureKeys: string[];
  relatedMemoryIds: number[];
}

// ---------------------------------------------------------------------------
// Obsidian helpers
// ---------------------------------------------------------------------------

/** Renders a YAML array (each item on its own indented line). */
function yamlArray(items: string[]): string {
  return items.map((item) => `  - ${item}`).join("\n");
}

/** Escapes a string for use inside a mermaid node label. */
function mermaidEscape(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/[<>]/g, "");
}

/** Builds the Obsidian tag hierarchy array for a memory. */
function memoryTags(mem: BrainMemory): string[] {
  const tags: string[] = [];
  tags.push(`brain/memory/${mem.type}`);
  tags.push(`brain/scope/${mem.scope}`);
  tags.push(`brain/source/${mem.source}`);
  if (mem.status === "frozen") tags.push("brain/status/frozen");
  return tags;
}

/** Builds the Obsidian tag hierarchy array for a procedure. */
function procedureTags(proc: Procedure): string[] {
  return [
    `brain/procedure/${proc.status}`,
    `brain/scope/${proc.scope}`,
  ];
}

/** Builds cssclasses for a memory. */
function memoryCssClasses(mem: BrainMemory): string[] {
  const classes = ["brain-memory"];
  classes.push(`brain-${mem.status}`);
  return classes;
}

/** Builds cssclasses for a procedure. */
function procedureCssClasses(proc: Procedure): string[] {
  return ["brain-procedure", `brain-${proc.status}`];
}

/** Renders callout block for memory status. */
function memoryCallout(mem: BrainMemory): string[] {
  const accessed = mem.lastAccessed || "unknown";
  if (mem.status === "active") {
    return [
      `> [!success] Active — Confidence ${mem.confidence}`,
      `> Source: ${mem.source} | Accessed: ${accessed}`,
    ];
  }
  if (mem.status === "superseded") {
    return [
      "> [!warning] Superseded",
      "> This memory has been superseded by a newer version.",
    ];
  }
  if (mem.status === "frozen" && mem.source === "external") {
    return [
      "> [!caution] External (Frozen)",
      `> Low confidence (${mem.confidence}). Promote with \`/brain memory promote ${mem.id}\`.`,
    ];
  }
  if (mem.status === "frozen") {
    return [
      `> [!caution] Frozen — Confidence ${mem.confidence}`,
      `> Source: ${mem.source} | Accessed: ${accessed}`,
    ];
  }
  if (mem.status === "archived") {
    return ["> [!note] Archived", "> This memory is no longer active."];
  }
  return [
    `> [!info] ${mem.status} — Confidence ${mem.confidence}`,
    `> Source: ${mem.source} | Accessed: ${accessed}`,
  ];
}

/** Renders callout block for procedure status. */
function procedureCallout(proc: Procedure): string[] {
  const stats = `${proc.successCount} successes, ${proc.failureCount} failures`;
  if (proc.status === "mature") {
    return [`> [!success] Mature — Confidence ${proc.confidence}`, `> ${stats}`];
  }
  if (proc.status === "reinforced") {
    return [`> [!info] Reinforced — Confidence ${proc.confidence}`, `> ${stats}`];
  }
  if (proc.status === "tentative") {
    return [`> [!warning] Tentative — Confidence ${proc.confidence}`, `> ${stats}`];
  }
  if (proc.status === "contradicted") {
    return ["> [!danger] Contradicted", "> This procedure has conflicting evidence. Review pending."];
  }
  return [`> [!info] ${proc.status} — Confidence ${proc.confidence}`, `> ${stats}`];
}

// ---------------------------------------------------------------------------
// Render: memory
// ---------------------------------------------------------------------------

/**
 * Renders a single memory as markdown with YAML frontmatter.
 *
 * Two modes:
 * - **Legacy** (no arg or `string[]`): flat frontmatter, plain evidence
 *   list — backward-compatible with existing tests/consumers.
 * - **Obsidian-native** (`RenderContext`): typed Properties (tag arrays,
 *   cssclasses, aliases, separate project field), callout blocks,
 *   wikilinks, mermaid evidence chain diagrams.
 */
export function renderMemoryMarkdown(mem: BrainMemory, evidenceOrCtx?: string[] | RenderContext): string {
  if (evidenceOrCtx !== undefined && !Array.isArray(evidenceOrCtx)) {
    return renderMemoryObsidian(mem, evidenceOrCtx);
  }
  return renderMemoryLegacy(mem, (evidenceOrCtx as string[] | undefined) ?? []);
}

/** Legacy format — kept for backward compatibility. */
function renderMemoryLegacy(mem: BrainMemory, evidenceIds: string[]): string {
  const scopeStr = mem.scope === "project" && mem.projectKey ? `${mem.scope}:${mem.projectKey}` : mem.scope;

  const lines = [
    "---",
    `id: ${mem.id}`,
    `kind: ${mem.type}`,
    `scope: ${scopeStr}`,
    `confidence: ${mem.confidence}`,
    `status: ${mem.status}`,
    `source: ${mem.source}`,
  ];

  if (mem.tags) lines.push(`tags: ${mem.tags}`);
  lines.push(`created: ${mem.createdAt}`);
  lines.push(`accessed: ${mem.lastAccessed}`);
  lines.push("---");
  lines.push("");
  lines.push(mem.content);

  if (evidenceIds.length) {
    lines.push("", "## Evidence", "");
    for (const eid of evidenceIds) lines.push(`- ${eid}`);
  }

  return lines.join("\n") + "\n";
}

/** Obsidian-native format with typed Properties, callouts, wikilinks, mermaid. */
function renderMemoryObsidian(mem: BrainMemory, ctx: RenderContext): string {
  const tags = memoryTags(mem);
  const cssclasses = memoryCssClasses(mem);
  const evidenceIds = ctx.evidenceIds;

  const lines = [
    "---",
    `id: ${mem.id}`,
    `kind: ${mem.type}`,
  ];

  // Scope + project as separate fields
  if (mem.scope === "project" && mem.projectKey) {
    lines.push(`scope: ${mem.scope}`);
    lines.push(`project: ${mem.projectKey}`);
  } else {
    lines.push(`scope: ${mem.scope}`);
  }

  lines.push(`confidence: ${mem.confidence}`);
  lines.push(`status: ${mem.status}`);
  lines.push(`source: ${mem.source}`);

  // Tags as YAML array with hierarchy
  const userTags = mem.tags ? mem.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const allTags = [...tags, ...userTags];
  lines.push("tags:");
  lines.push(yamlArray(allTags));

  lines.push("cssclasses:");
  lines.push(yamlArray(cssclasses));

  lines.push(`created: ${mem.createdAt}`);
  lines.push(`accessed: ${mem.lastAccessed}`);

  // Aliases for Obsidian search (use slug to avoid colliding with body text)
  lines.push("aliases:");
  lines.push(`  - ${memorySlug(mem)}`);

  lines.push("---");
  lines.push("");

  // Callout block
  lines.push(...memoryCallout(mem));
  lines.push("");

  // Content
  lines.push(mem.content);

  // Wikilinks
  if (ctx.relatedProcedureKeys.length > 0 || ctx.relatedMemoryIds.length > 0) {
    const links: string[] = [];
    for (const key of ctx.relatedProcedureKeys) links.push(`[[${key}]]`);
    for (const mid of ctx.relatedMemoryIds) links.push(`[[memory-${mid}]]`);
    lines.push("");
    lines.push(`Related: ${links.join(" | ")}`);
  }

  // Evidence section
  if (evidenceIds.length) {
    lines.push("", "## Evidence", "");
    for (const eid of evidenceIds) lines.push(`- ${eid}`);

    // Mermaid evidence chain (2+ links)
    if (evidenceIds.length >= 2) {
      lines.push("", "## Evidence Chain", "", "```mermaid", "graph LR");

      const parsed = evidenceIds.map((raw) => {
        const m = raw.match(/^(\S+)\s+\(([^)]+)\)$/);
        return m ? { expId: m[1], relation: m[2] } : { expId: raw, relation: "linked" };
      });

      for (const { expId } of parsed) {
        const safeId = expId.replace(/[^a-zA-Z0-9_]/g, "_");
        lines.push(`    ${safeId}["${mermaidEscape(expId)}"]`);
      }
      const memNode = `mem_${mem.id}`;
      lines.push(`    ${memNode}(("Memory ${mem.id}<br/>${mermaidEscape(mem.type)}"))`);
      for (const { expId, relation } of parsed) {
        const safeId = expId.replace(/[^a-zA-Z0-9_]/g, "_");
        lines.push(`    ${safeId} -->|${mermaidEscape(relation)}| ${memNode}`);
      }
      lines.push("```");
    }
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Render: procedure
// ---------------------------------------------------------------------------

/**
 * Renders a single procedure as markdown with YAML frontmatter.
 *
 * Two modes (same as renderMemoryMarkdown):
 * - **Legacy** (`string[]` or omitted): flat frontmatter.
 * - **Obsidian-native** (`RenderContext`): typed Properties, callouts,
 *   wikilinks, mermaid trigger/avoid/prefer diagram.
 */
export function renderProcedureMarkdown(proc: Procedure, evidenceOrCtx?: string[] | RenderContext): string {
  if (evidenceOrCtx !== undefined && !Array.isArray(evidenceOrCtx)) {
    return renderProcedureObsidian(proc, evidenceOrCtx);
  }
  return renderProcedureLegacy(proc, (evidenceOrCtx as string[] | undefined) ?? []);
}

/** Legacy format — kept for backward compatibility. */
function renderProcedureLegacy(proc: Procedure, evidenceIds: string[]): string {
  const lines = [
    "---",
    `id: ${proc.id}`,
    `key: ${proc.key}`,
    `status: ${proc.status}`,
    `confidence: ${proc.confidence}`,
    `scope: ${proc.scope}`,
    `success_count: ${proc.successCount}`,
    `failure_count: ${proc.failureCount}`,
    `created: ${proc.createdAt}`,
    `updated: ${proc.updatedAt}`,
    "---",
    "",
    "## Trigger",
    proc.triggerText,
  ];

  if (proc.avoidText) lines.push("", "## Avoid", proc.avoidText);
  if (proc.preferText) lines.push("", "## Prefer", proc.preferText);

  if (evidenceIds.length) {
    lines.push("", "## Evidence", "");
    for (const eid of evidenceIds) lines.push(`- ${eid}`);
  }

  return lines.join("\n") + "\n";
}

/** Obsidian-native format with typed Properties, callouts, wikilinks, mermaid. */
function renderProcedureObsidian(proc: Procedure, ctx: RenderContext): string {
  const tags = procedureTags(proc);
  const cssclasses = procedureCssClasses(proc);
  const evidenceIds = ctx.evidenceIds;

  const lines = [
    "---",
    `id: ${proc.id}`,
    `key: ${proc.key}`,
    `status: ${proc.status}`,
    `confidence: ${proc.confidence}`,
    `scope: ${proc.scope}`,
  ];

  if (proc.scope === "project" && proc.projectKey) {
    lines.push(`project: ${proc.projectKey}`);
  }

  lines.push(`success_count: ${proc.successCount}`);
  lines.push(`failure_count: ${proc.failureCount}`);

  lines.push("tags:");
  lines.push(yamlArray(tags));

  lines.push("cssclasses:");
  lines.push(yamlArray(cssclasses));

  lines.push(`created: ${proc.createdAt}`);
  lines.push(`updated: ${proc.updatedAt}`);
  lines.push("---");
  lines.push("");

  // Callout block
  lines.push(...procedureCallout(proc));
  lines.push("");

  // Sections
  lines.push("## Trigger");
  lines.push(proc.triggerText);

  if (proc.avoidText) lines.push("", "## Avoid", proc.avoidText);
  if (proc.preferText) lines.push("", "## Prefer", proc.preferText);

  // Wikilinks to related memories
  if (ctx.relatedMemoryIds.length > 0) {
    const links = ctx.relatedMemoryIds.map((mid) => `[[memory-${mid}]]`);
    lines.push("", `See also: ${links.join(" | ")}`);
  }

  // Mermaid trigger/avoid/prefer diagram
  if (proc.avoidText || proc.preferText) {
    lines.push("", "## Flow", "", "```mermaid", "graph TD");
    lines.push(`    trigger["Trigger<br/>${mermaidEscape(proc.triggerText.slice(0, 60))}"]`);
    if (proc.avoidText) {
      lines.push(`    avoid["Avoid<br/>${mermaidEscape(proc.avoidText.slice(0, 60))}"]`);
      lines.push("    trigger --> avoid");
      lines.push("    style avoid fill:#ff6b6b,color:#fff");
    }
    if (proc.preferText) {
      lines.push(`    prefer["Prefer<br/>${mermaidEscape(proc.preferText.slice(0, 60))}"]`);
      lines.push("    trigger --> prefer");
      lines.push("    style prefer fill:#51cf66,color:#fff");
    }
    lines.push("```");
  }

  // Evidence
  if (evidenceIds.length) {
    lines.push("", "## Evidence", "");
    for (const eid of evidenceIds) lines.push(`- ${eid}`);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Splits a markdown file into its YAML frontmatter (as a flat key/value
 * map) and the body. Handles both flat scalar values and YAML arrays
 * (collapsing array items to comma-separated strings for backward
 * compatibility). Returns `null` when the file doesn't open with a `---`
 * frontmatter block. */
function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  const fmLines = match[1].split("\n");

  let currentKey = "";
  let arrayValues: string[] = [];
  let inArray = false;

  const flushArray = () => {
    if (inArray && currentKey) {
      fm[currentKey] = arrayValues.join(",");
      arrayValues = [];
      inArray = false;
      currentKey = "";
    }
  };

  for (const line of fmLines) {
    // Array continuation: "  - value"
    const arrayItem = line.match(/^\s+-\s+(.+)$/);
    if (arrayItem && inArray) {
      const val = arrayItem[1].replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
      arrayValues.push(val);
      continue;
    }

    // New key line
    const kv = line.match(/^([\w_]+):\s*(.*)$/);
    if (kv) {
      flushArray();
      const key = kv[1];
      const value = kv[2].trim();
      if (value === "") {
        // Start of a YAML array
        currentKey = key;
        inArray = true;
        arrayValues = [];
      } else {
        fm[key] = value;
      }
    }
  }
  flushArray();

  return { fm, body: match[2].trim() };
}

/**
 * Parses a memory markdown file back into partial `BrainMemory` fields.
 * Handles both legacy format (scope: project:waywiser, tags: flat) and
 * new Obsidian-native format (separate project field, tag arrays,
 * callout blocks, wikilinks). Returns `null` if unparseable.
 */
export function parseMemoryMarkdown(content: string): Partial<BrainMemory> | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const { fm, body } = parsed;

  let memBody = body;

  // Strip callout block at the start (lines starting with "> [!" or "> ")
  const calloutLines: string[] = [];
  const bodyLines = memBody.split("\n");
  let i = 0;
  while (i < bodyLines.length && bodyLines[i].startsWith("> ")) {
    calloutLines.push(bodyLines[i]);
    i++;
  }
  // Skip blank line after callout
  if (i < bodyLines.length && bodyLines[i].trim() === "") i++;
  memBody = bodyLines.slice(i).join("\n");

  // Strip from first ## section onward
  const sectionStart = memBody.indexOf("\n## ");
  if (sectionStart >= 0) {
    memBody = memBody.slice(0, sectionStart);
  }

  // Strip "Related:" wikilink line
  memBody = memBody.replace(/\nRelated:.*$/m, "");

  const memContent = memBody.trim();

  // Handle scope: support both "project:waywiser" and separate "project" field
  let scope: string;
  let projectKey: string | null;

  if (fm.project) {
    scope = fm.scope ?? "global";
    projectKey = fm.project;
  } else if (fm.scope?.includes(":")) {
    const [scopePart, ...projectParts] = fm.scope.split(":");
    scope = scopePart;
    projectKey = projectParts.join(":");
  } else {
    scope = fm.scope ?? "global";
    projectKey = null;
  }

  // Tags: filter out brain/ hierarchy tags, keep user tags
  let tags = "";
  if (fm.tags) {
    const allTags = fm.tags.split(",").map((t) => t.trim()).filter(Boolean);
    const userTags = allTags.filter((t) => !t.startsWith("brain/"));
    tags = userTags.join(",");
  }

  return {
    id: fm.id ? Number(fm.id) : undefined,
    type: fm.kind as BrainMemory["type"],
    scope: scope as BrainMemory["scope"],
    projectKey,
    confidence: fm.confidence ? Number(fm.confidence) : undefined,
    status: fm.status as BrainMemory["status"],
    source: fm.source as BrainMemory["source"],
    tags,
    content: memContent,
    createdAt: fm.created,
    lastAccessed: fm.accessed,
  };
}

/**
 * Parses a procedure markdown file back into partial `Procedure` fields.
 * Handles both legacy and Obsidian-native formats (callouts, mermaid
 * blocks, wikilinks are stripped). Returns `null` if unparseable.
 */
export function parseProcedureMarkdown(content: string): Partial<Procedure> | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const { fm, body } = parsed;

  const sections: Record<string, string> = {};
  let currentSection = "";
  let inMermaid = false;

  for (const line of body.split("\n")) {
    // Skip mermaid blocks entirely
    if (line.trim() === "```mermaid") { inMermaid = true; continue; }
    if (inMermaid) {
      if (line.trim() === "```") inMermaid = false;
      continue;
    }
    // Skip callout lines (only before first section)
    if (line.startsWith("> ") && currentSection === "") continue;
    // Skip "See also:" wikilink lines
    if (line.startsWith("See also:")) continue;

    const heading = line.match(/^## (.+)$/);
    if (heading) {
      currentSection = heading[1].toLowerCase();
    } else if (currentSection && currentSection !== "flow" && currentSection !== "evidence chain") {
      sections[currentSection] = ((sections[currentSection] || "") + "\n" + line).trim();
    }
  }

  return {
    id: fm.id,
    key: fm.key,
    status: fm.status as Procedure["status"],
    confidence: fm.confidence ? Number(fm.confidence) : undefined,
    scope: fm.scope as Procedure["scope"],
    projectKey: fm.project ?? null,
    successCount: fm.success_count ? Number(fm.success_count) : undefined,
    failureCount: fm.failure_count ? Number(fm.failure_count) : undefined,
    triggerText: sections.trigger || "",
    avoidText: sections.avoid || null,
    preferText: sections.prefer || null,
    createdAt: fm.created,
    updatedAt: fm.updated,
  };
}

// ---------------------------------------------------------------------------
// MOC (Map of Content) generation
// ---------------------------------------------------------------------------

/** Generates a MOC file for semantic memories. */
export function generateSemanticMOC(memories: BrainMemory[], now: string): string {
  const active = memories.filter((m) => m.status === "active");
  const byType: Record<string, BrainMemory[]> = {};
  for (const m of active) (byType[m.type] ??= []).push(m);

  const lines = [
    "---",
    "tags:",
    "  - brain/moc",
    "cssclasses:",
    "  - brain-moc",
    "---",
    "",
    "# Semantic Memories",
    "",
    `> [!info] ${active.length} active memories | Last updated: ${now}`,
    "",
    "## By Type",
  ];

  for (const [type, label] of [["fact", "Facts"], ["preference", "Preferences"], ["decision", "Decisions"], ["lesson", "Lessons"]] as const) {
    const items = byType[type];
    if (!items?.length) continue;
    lines.push("", `### ${label}`);
    for (const m of items) lines.push(`- [[${memorySlug(m)}]]`);
  }

  const highConf = active.filter((m) => m.confidence >= 0.8).sort((a, b) => b.confidence - a.confidence);
  const medConf = active.filter((m) => m.confidence >= 0.5 && m.confidence < 0.8).sort((a, b) => b.confidence - a.confidence);
  const lowConf = active.filter((m) => m.confidence < 0.5).sort((a, b) => b.confidence - a.confidence);

  if (highConf.length || medConf.length || lowConf.length) {
    lines.push("", "## By Confidence");
  }
  if (highConf.length) {
    lines.push("", "### High (>=0.8)");
    for (const m of highConf) lines.push(`- [[${memorySlug(m)}]] (${m.confidence})`);
  }
  if (medConf.length) {
    lines.push("", "### Medium (0.5-0.8)");
    for (const m of medConf) lines.push(`- [[${memorySlug(m)}]] (${m.confidence})`);
  }
  if (lowConf.length) {
    lines.push("", "### Low (<0.5)");
    for (const m of lowConf) lines.push(`- [[${memorySlug(m)}]] (${m.confidence})`);
  }

  return lines.join("\n") + "\n";
}

/** Generates a MOC file for procedures. */
export function generateProceduresMOC(procedures: Procedure[], now: string): string {
  const byStatus: Record<string, Procedure[]> = {};
  for (const p of procedures) (byStatus[p.status] ??= []).push(p);

  const lines = [
    "---",
    "tags:",
    "  - brain/moc",
    "cssclasses:",
    "  - brain-moc",
    "---",
    "",
    "# Procedures",
    "",
    `> [!info] ${procedures.length} procedures | Last updated: ${now}`,
  ];

  for (const [status, label] of [
    ["mature", "Mature (ready for evolution)"],
    ["reinforced", "Reinforced"],
    ["tentative", "Tentative"],
    ["contradicted", "Contradicted"],
  ] as const) {
    const items = byStatus[status];
    if (!items?.length) continue;
    lines.push("", `## ${label}`);
    for (const p of items) {
      lines.push(`- [[${procedureSlug(p)}]] — confidence: ${p.confidence}, ${p.successCount} successes`);
    }
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Brain overview canvas
// ---------------------------------------------------------------------------

interface CanvasNode {
  id: string;
  type: "text" | "file";
  text?: string;
  file?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
}

/** Generates a _brain-overview.canvas Obsidian Canvas JSON file. */
export function generateBrainCanvas(
  memories: BrainMemory[],
  procedures: Procedure[],
  structure: { semantic: string; procedures: string },
): string {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  const activeMemories = memories.filter((m) => m.status === "active");
  const activeProcedures = procedures.filter((p) => p.status !== "retired");

  // Summary nodes
  const memStats: Record<string, number> = {};
  for (const m of activeMemories) memStats[m.type] = (memStats[m.type] ?? 0) + 1;
  const memSummary = Object.entries(memStats).map(([t, c]) => `${t}: ${c}`).join("\\n");

  nodes.push({
    id: "n_mem_summary",
    type: "text",
    text: `## Memories\n${activeMemories.length} active\n${memSummary}`,
    x: 0, y: 0, width: 250, height: 120,
    color: "4",
  });

  const procStats: Record<string, number> = {};
  for (const p of activeProcedures) procStats[p.status] = (procStats[p.status] ?? 0) + 1;
  const procSummary = Object.entries(procStats).map(([s, c]) => `${s}: ${c}`).join("\\n");

  nodes.push({
    id: "n_proc_summary",
    type: "text",
    text: `## Procedures\n${activeProcedures.length} active\n${procSummary}`,
    x: 400, y: 0, width: 250, height: 120,
    color: "3",
  });

  // Individual file nodes for mature procedures
  let procY = 160;
  for (const p of activeProcedures.filter((p) => p.status === "mature").slice(0, 10)) {
    const nodeId = `n_proc_${p.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
    nodes.push({
      id: nodeId, type: "file",
      file: `${structure.procedures}/${procedureSlug(p)}.md`,
      x: 400, y: procY, width: 250, height: 60,
    });
    procY += 80;
  }

  // Individual file nodes for high-confidence memories
  let memY = 160;
  for (const m of [...activeMemories].sort((a, b) => b.confidence - a.confidence).slice(0, 10)) {
    nodes.push({
      id: `n_mem_${m.id}`, type: "file",
      file: `${structure.semantic}/${memorySlug(m)}.md`,
      x: 0, y: memY, width: 250, height: 60,
    });
    memY += 80;
  }

  return JSON.stringify({ nodes, edges }, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Stale file cleanup
// ---------------------------------------------------------------------------

function removeStaleVaultFiles(store: BrainStore, idColumn: "memory_id" | "procedure_id", id: number | string, currentFilePath: string): void {
  const stale = store.db
    .prepare(`SELECT file_path FROM vault_sync WHERE ${idColumn} = ? AND file_path != ?`)
    .all(id, currentFilePath) as Array<{ file_path: string }>;

  for (const { file_path } of stale) {
    try { fs.rmSync(file_path); } catch { /* already gone */ }
    store.db.prepare("DELETE FROM vault_sync WHERE file_path = ?").run(file_path);
  }
}

// ---------------------------------------------------------------------------
// Relationship queries (for building RenderContext in outbound sync)
// ---------------------------------------------------------------------------

/** Finds procedure keys related to a memory via shared experiences. */
function queryRelatedProcedureKeys(store: BrainStore, memoryId: number): string[] {
  try {
    const rows = store.db
      .prepare(
        `SELECT DISTINCT p.key FROM procedures p
         JOIN procedure_evidence pe ON pe.procedure_id = p.id
         JOIN memory_evidence me ON me.experience_id = pe.experience_id
         WHERE me.memory_id = ? LIMIT 10`,
      )
      .all(memoryId) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  } catch { return []; }
}

/** Finds memory IDs related to a procedure via shared experiences. */
function queryRelatedMemoryIds(store: BrainStore, procedureId: string): number[] {
  try {
    const rows = store.db
      .prepare(
        `SELECT DISTINCT me.memory_id FROM memory_evidence me
         JOIN procedure_evidence pe ON pe.experience_id = me.experience_id
         WHERE pe.procedure_id = ? LIMIT 10`,
      )
      .all(procedureId) as Array<{ memory_id: number }>;
    return rows.map((r) => r.memory_id);
  } catch { return []; }
}

/** Fetches evidence IDs for a procedure. */
function queryProcedureEvidenceIds(store: BrainStore, procedureId: string): string[] {
  try {
    const rows = store.db
      .prepare(
        `SELECT experience_id, outcome FROM procedure_evidence
         WHERE procedure_id = ? ORDER BY created_at ASC`,
      )
      .all(procedureId) as Array<{ experience_id: string; outcome: string }>;
    return rows.map((r) => `${r.experience_id} (${r.outcome})`);
  } catch { return []; }
}

/** Writes a file only if its content differs from what is on disk. */
function writeIfChanged(filePath: string, content: string): void {
  try {
    if (fs.readFileSync(filePath, "utf-8") === content) return;
  } catch { /* file doesn't exist yet */ }
  fs.writeFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// Sync: outbound (DB -> vault)
// ---------------------------------------------------------------------------

/**
 * Syncs DB -> vault: renders every active memory and every non-retired
 * procedure to Obsidian-native markdown and writes it to disk. A file
 * is only (re)written when its rendered content hash differs from what's
 * already on disk (tracked via `vault_sync`). Called at session_shutdown.
 *
 * After individual files, generates MOC index files (at markdownRoot)
 * and a brain overview canvas.
 */
export async function vaultSyncOutbound(store: BrainStore, config: BrainConfig): Promise<void> {
  const root = config.markdownRoot;
  const structure = config.vault.structure;

  for (const sub of Object.values(structure)) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }

  let written = 0;

  // --- Memories ---
  const activeMemoryIds = store.db.prepare("SELECT id FROM memories WHERE status = 'active'").all() as Array<{ id: number }>;
  const allActiveMemories: BrainMemory[] = [];

  for (const { id } of activeMemoryIds) {
    const mem = store.getMemory(id);
    if (!mem) continue;
    allActiveMemories.push(mem);

    const slug = memorySlug(mem);
    const filePath = path.join(root, structure.semantic, `${slug}.md`);
    removeStaleVaultFiles(store, "memory_id", mem.id, filePath);

    const evidence = store.getMemoryEvidence(mem.id);
    const evidenceIds = evidence.map((e) => `${e.experienceId} (${e.relation})`);
    const relatedProcKeys = queryRelatedProcedureKeys(store, mem.id);

    const ctx: RenderContext = {
      evidenceIds,
      relatedProcedureKeys: relatedProcKeys,
      relatedMemoryIds: [],
    };

    const content = renderMemoryMarkdown(mem, ctx);
    const hash = contentHash(content);

    const syncState = store.getVaultSyncState(filePath);
    if (syncState && syncState.contentHash === hash) continue;

    fs.writeFileSync(filePath, content);
    store.upsertVaultSync(filePath, hash, mem.id, null);
    written++;
  }

  // --- Procedures ---
  const activeProcIds = store.db.prepare("SELECT id FROM procedures WHERE status != 'retired'").all() as Array<{ id: string }>;
  const allActiveProcedures: Procedure[] = [];

  for (const { id } of activeProcIds) {
    const proc = store.getProcedureById(id);
    if (!proc) continue;
    allActiveProcedures.push(proc);

    const slug = procedureSlug(proc);
    const filePath = path.join(root, structure.procedures, `${slug}.md`);
    removeStaleVaultFiles(store, "procedure_id", proc.id, filePath);

    const relatedMemIds = queryRelatedMemoryIds(store, proc.id);
    const procEvidence = queryProcedureEvidenceIds(store, proc.id);

    const ctx: RenderContext = {
      evidenceIds: procEvidence,
      relatedProcedureKeys: [],
      relatedMemoryIds: relatedMemIds,
    };

    const content = renderProcedureMarkdown(proc, ctx);
    const hash = contentHash(content);

    const syncState = store.getVaultSyncState(filePath);
    if (syncState && syncState.contentHash === hash) continue;

    fs.writeFileSync(filePath, content);
    store.upsertVaultSync(filePath, hash, null, proc.id);
    written++;
  }

  // --- MOC files (at root level, outside subdirectories) ---
  const now = new Date().toISOString();

  if (allActiveMemories.length > 0) {
    const semanticMOC = generateSemanticMOC(allActiveMemories, now);
    writeIfChanged(path.join(root, "_MOC-semantic.md"), semanticMOC);
  }

  if (allActiveProcedures.length > 0) {
    const proceduresMOC = generateProceduresMOC(allActiveProcedures, now);
    writeIfChanged(path.join(root, "_MOC-procedures.md"), proceduresMOC);
  }

  // --- Brain overview canvas ---
  if (allActiveMemories.length > 0 || allActiveProcedures.length > 0) {
    const canvas = generateBrainCanvas(allActiveMemories, allActiveProcedures, structure);
    writeIfChanged(path.join(root, "_brain-overview.canvas"), canvas);
  }

  store.logBrain("vault-sync-outbound", `Synced ${written} file(s) to ${root}`);
}

// ---------------------------------------------------------------------------
// Sync: inbound (vault -> DB)
// ---------------------------------------------------------------------------

/**
 * Syncs vault -> DB: for every file tracked in `vault_sync`, compares its
 * current on-disk content hash against the hash Brain recorded the last
 * time it wrote that file. A mismatch means a human edited the file since
 * — that content is imported into the DB as user-authoritative
 * (`source = 'user'` for memories; procedures get their text fields
 * overwritten directly). Called at session_start.
 */
export async function vaultSyncInbound(store: BrainStore, config: BrainConfig): Promise<void> {
  void config; // reserved for future conflict-resolution policies beyond "human-wins"

  const allSync = store.getAllVaultSync();
  let imported = 0;

  for (const syncRow of allSync) {
    if (!fs.existsSync(syncRow.filePath)) continue;

    const currentContent = fs.readFileSync(syncRow.filePath, "utf-8");
    const currentHash = contentHash(currentContent);
    if (currentHash === syncRow.contentHash) continue;

    if (syncRow.memoryId !== null) {
      const parsed = parseMemoryMarkdown(currentContent);
      if (parsed && parsed.content) {
        store.db
          .prepare(
            "UPDATE memories SET content = ?, confidence = ?, source = 'user', last_accessed = datetime('now') WHERE id = ?",
          )
          .run(parsed.content, parsed.confidence ?? 0.9, syncRow.memoryId);
        imported++;
      }
    } else if (syncRow.procedureId !== null) {
      const parsed = parseProcedureMarkdown(currentContent);
      if (parsed && parsed.triggerText) {
        store.db
          .prepare(
            "UPDATE procedures SET trigger_text = ?, avoid_text = ?, prefer_text = ?, confidence = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .run(parsed.triggerText, parsed.avoidText ?? null, parsed.preferText ?? null, parsed.confidence ?? 0.5, syncRow.procedureId);
        imported++;
      }
    }

    store.upsertVaultSync(syncRow.filePath, currentHash, syncRow.memoryId, syncRow.procedureId);
  }

  if (imported > 0) {
    store.logBrain("vault-sync-inbound", `Imported ${imported} human edit(s)`);
  }
}
