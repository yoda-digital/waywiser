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
// Render: memory
// ---------------------------------------------------------------------------

/**
 * Renders a single memory as Obsidian-compatible markdown: YAML frontmatter
 * (id, kind, scope, confidence, status, source, tags, created, accessed)
 * followed by the memory's content and, if any evidence was passed, an
 * `## Evidence` section listing `experienceId (relation)` bullets.
 */
export function renderMemoryMarkdown(mem: BrainMemory, evidenceIds: string[] = []): string {
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

// ---------------------------------------------------------------------------
// Render: procedure
// ---------------------------------------------------------------------------

/**
 * Renders a single procedure as markdown: YAML frontmatter (id, key,
 * status, confidence, scope, success_count, failure_count, created,
 * updated) followed by `## Trigger` (always), `## Avoid` / `## Prefer`
 * (only when set), and — if evidence was passed — an `## Evidence` section.
 */
export function renderProcedureMarkdown(proc: Procedure, evidenceIds: string[] = []): string {
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

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Splits a markdown file into its YAML frontmatter (as a flat key/value
 * map — good enough for the scalar fields Brain writes) and the body.
 * Returns `null` when the file doesn't open with a `---` frontmatter
 * block, which is how both parse functions below report "unparseable". */
function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([\w_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: match[2].trim() };
}

/**
 * Parses a memory markdown file back into partial `BrainMemory` fields.
 * Splits `scope: project:waywiser` back into `scope: "project"` +
 * `projectKey: "waywiser"`. Returns `null` if the file has no parseable
 * frontmatter block.
 */
export function parseMemoryMarkdown(content: string): Partial<BrainMemory> | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const { fm, body } = parsed;

  // Everything before "## Evidence" is the memory's content; the rest is
  // metadata this parser doesn't need to round-trip.
  const contentEnd = body.indexOf("\n## Evidence");
  const memContent = contentEnd >= 0 ? body.slice(0, contentEnd).trim() : body.trim();

  const [scopePart, ...projectParts] = (fm.scope ?? "").split(":");

  return {
    id: fm.id ? Number(fm.id) : undefined,
    type: fm.kind as BrainMemory["type"],
    scope: (fm.scope?.includes(":") ? scopePart : fm.scope) as BrainMemory["scope"],
    projectKey: fm.scope?.includes(":") ? projectParts.join(":") : null,
    confidence: fm.confidence ? Number(fm.confidence) : undefined,
    status: fm.status as BrainMemory["status"],
    source: fm.source as BrainMemory["source"],
    tags: fm.tags ?? "",
    content: memContent,
    createdAt: fm.created,
    lastAccessed: fm.accessed,
  };
}

/**
 * Parses a procedure markdown file back into partial `Procedure` fields,
 * reading `## Trigger` / `## Avoid` / `## Prefer` sections out of the body.
 * Returns `null` if the file has no parseable frontmatter block.
 */
export function parseProcedureMarkdown(content: string): Partial<Procedure> | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const { fm, body } = parsed;

  const sections: Record<string, string> = {};
  let currentSection = "";
  for (const line of body.split("\n")) {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      currentSection = heading[1].toLowerCase();
    } else if (currentSection) {
      sections[currentSection] = ((sections[currentSection] || "") + "\n" + line).trim();
    }
  }

  return {
    id: fm.id,
    key: fm.key,
    status: fm.status as Procedure["status"],
    confidence: fm.confidence ? Number(fm.confidence) : undefined,
    scope: fm.scope as Procedure["scope"],
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
// Stale file cleanup
// ---------------------------------------------------------------------------

/**
 * Removes any `vault_sync`-tracked file for the given memory/procedure
 * whose path no longer matches `currentFilePath` — i.e. a prior render
 * under a since-changed (content-derived) slug. Deletes the file from
 * disk (best-effort; already-missing is fine) and drops its `vault_sync`
 * row so it doesn't linger as an orphaned entry.
 */
function removeStaleVaultFiles(store: BrainStore, idColumn: "memory_id" | "procedure_id", id: number | string, currentFilePath: string): void {
  const stale = store.db
    .prepare(`SELECT file_path FROM vault_sync WHERE ${idColumn} = ? AND file_path != ?`)
    .all(id, currentFilePath) as Array<{ file_path: string }>;

  for (const { file_path } of stale) {
    try {
      fs.rmSync(file_path);
    } catch {
      // already gone — nothing to clean up
    }
    store.db.prepare("DELETE FROM vault_sync WHERE file_path = ?").run(file_path);
  }
}

// ---------------------------------------------------------------------------
// Sync: outbound (DB -> vault)
// ---------------------------------------------------------------------------

/**
 * Syncs DB -> vault: renders every active memory and every non-retired
 * procedure to markdown and writes it to disk. A file is only (re)written
 * when its rendered content hash differs from the hash tracked in
 * `vault_sync` for that path — an unmodified render leaves the file's
 * mtime untouched. Called at session_shutdown.
 *
 * All memories currently land under `structure.semantic` regardless of
 * type — routing by type/scope into `projects`/`entities`/`hypotheses` is
 * not yet implemented.
 */
export async function vaultSyncOutbound(store: BrainStore, config: BrainConfig): Promise<void> {
  const root = config.markdownRoot;
  const structure = config.vault.structure;

  for (const sub of Object.values(structure)) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }

  let written = 0;

  const activeMemoryIds = store.db.prepare("SELECT id FROM memories WHERE status = 'active'").all() as Array<{
    id: number;
  }>;

  for (const { id } of activeMemoryIds) {
    const mem = store.getMemory(id);
    if (!mem) continue;

    const slug = memorySlug(mem);
    const filePath = path.join(root, structure.semantic, `${slug}.md`);

    // Slugs are content-derived, so an edit that changes the slug leaves
    // the previously-written file behind under its old name — remove it
    // (and its stale vault_sync row) rather than accumulate orphans.
    removeStaleVaultFiles(store, "memory_id", mem.id, filePath);

    const evidence = store.getMemoryEvidence(mem.id);
    const evidenceIds = evidence.map((e) => `${e.experienceId} (${e.relation})`);

    const content = renderMemoryMarkdown(mem, evidenceIds);
    const hash = contentHash(content);

    const syncState = store.getVaultSyncState(filePath);
    if (syncState && syncState.contentHash === hash) continue; // unchanged — leave file alone

    fs.writeFileSync(filePath, content);
    store.upsertVaultSync(filePath, hash, mem.id, null);
    written++;
  }

  const activeProcIds = store.db.prepare("SELECT id FROM procedures WHERE status != 'retired'").all() as Array<{
    id: string;
  }>;

  for (const { id } of activeProcIds) {
    const proc = store.getProcedureById(id);
    if (!proc) continue;

    const slug = procedureSlug(proc);
    const filePath = path.join(root, structure.procedures, `${slug}.md`);

    removeStaleVaultFiles(store, "procedure_id", proc.id, filePath);

    const content = renderProcedureMarkdown(proc);
    const hash = contentHash(content);

    const syncState = store.getVaultSyncState(filePath);
    if (syncState && syncState.contentHash === hash) continue;

    fs.writeFileSync(filePath, content);
    store.upsertVaultSync(filePath, hash, null, proc.id);
    written++;
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
 * (`source = 'user'` for memories; procedures have no source column but
 * get their text fields overwritten directly). A file that was deleted or
 * never existed is silently skipped; the `vault_sync` row is left as-is
 * for a future outbound sync to recreate it. Called at session_start.
 */
export async function vaultSyncInbound(store: BrainStore, config: BrainConfig): Promise<void> {
  void config; // reserved for future conflict-resolution policies beyond "human-wins"

  const allSync = store.getAllVaultSync();
  let imported = 0;

  for (const syncRow of allSync) {
    if (!fs.existsSync(syncRow.filePath)) continue;

    const currentContent = fs.readFileSync(syncRow.filePath, "utf-8");
    const currentHash = contentHash(currentContent);
    if (currentHash === syncRow.contentHash) continue; // no human edit since last sync

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
