/**
 * waywiser-brain — skill lifecycle.
 *
 * Skills live on disk in three directories under `config.skillsRoot`:
 * `active/{name}/` (the one version Pi discovers via `resources_discover`),
 * `candidates/{name}/{versionHash}/` (proposed-but-unproven versions), and
 * `retired/{name}/{versionHash}/` (superseded or rejected versions, kept
 * for rollback and audit). Every version directory carries a `SKILL.md`
 * (the Pi-native skill body) and a `metadata.json` (id, version hash,
 * parent version, source procedures, timestamps) that mirrors the
 * `skill_versions` row for that version.
 *
 * The filesystem is the source of truth for *content*; the database is the
 * source of truth for *status* and lineage queries. Every mutation here
 * touches both — write the files first, then record the database change —
 * so a crash mid-operation leaves an orphaned directory (recoverable by
 * inspection) rather than a database row pointing at nothing.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BrainConfig, SkillVersion } from "./types.ts";
import type { BrainStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/** Deterministic short SHA-256 of a SKILL.md body, used as the version's
 * directory name and database key. Truncated to 16 hex chars — plenty of
 * collision resistance for a single skill's version history, and short
 * enough to stay readable in paths and logs. */
export function computeVersionHash(content: string): string {
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Directory setup
// ---------------------------------------------------------------------------

/** Ensures `{skillsRoot}/active`, `{skillsRoot}/candidates`, and
 * `{skillsRoot}/retired` exist. Safe to call repeatedly. */
export function ensureSkillDirs(config: BrainConfig): void {
  for (const sub of ["active", "candidates", "retired"]) {
    fs.mkdirSync(path.join(config.skillsRoot, sub), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// metadata.json helpers
// ---------------------------------------------------------------------------

interface SkillMetadata {
  id: string;
  versionHash: string;
  parentVersion: string | null;
  sourceProcedureIds: string[];
  evalRunId: string | null;
  createdAt: string;
  promotedAt: string | null;
}

function readMetadata(dir: string): SkillMetadata | null {
  const metaPath = path.join(dir, "metadata.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as SkillMetadata;
  } catch {
    return null; // corrupt metadata — treat as absent rather than throwing
  }
}

function writeMetadata(dir: string, meta: SkillMetadata): void {
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// writeCandidate
// ---------------------------------------------------------------------------

/**
 * Writes a new candidate skill version to
 * `{skillsRoot}/candidates/{name}/{versionHash}/` (SKILL.md + metadata.json)
 * and records it in the database as `status: "candidate"`. The parent
 * version, if any, is read from the currently active version's metadata so
 * rollback/lineage queries have somewhere to point.
 */
export function writeCandidate(
  name: string,
  skillMd: string,
  sourceProcedureIds: string[],
  config: BrainConfig,
  store: BrainStore,
): SkillVersion {
  const versionHash = computeVersionHash(skillMd);
  const dir = path.join(config.skillsRoot, "candidates", name, versionHash);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, "SKILL.md"), skillMd);

  const activeMeta = readMetadata(path.join(config.skillsRoot, "active", name));
  const parentVersion = activeMeta?.versionHash ?? null;

  const id = `sv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const sv: SkillVersion = {
    id,
    name,
    versionHash,
    parentVersion,
    status: "candidate",
    sourceProcedureIds,
    path: dir,
    evalRunId: null,
    createdAt: new Date().toISOString(),
    promotedAt: null,
  };

  writeMetadata(dir, {
    id: sv.id,
    versionHash: sv.versionHash,
    parentVersion: sv.parentVersion,
    sourceProcedureIds: sv.sourceProcedureIds,
    evalRunId: sv.evalRunId,
    createdAt: sv.createdAt,
    promotedAt: sv.promotedAt,
  });

  store.insertSkillVersion(sv);

  return sv;
}

// ---------------------------------------------------------------------------
// promoteCandidate
// ---------------------------------------------------------------------------

/**
 * Promotes a candidate to active:
 *   1. If an active version already exists, it is copied to
 *      `retired/{name}/{oldVersionHash}/` and its database row(s) marked
 *      `retired`.
 *   2. The candidate directory is copied to `active/{name}/` and its
 *      metadata gets a `promotedAt` timestamp.
 *   3. The database row for this version is marked `active`.
 *   4. The now-empty candidate version directory (and its parent `{name}/`
 *      directory, if left empty) is removed.
 */
export function promoteCandidate(
  name: string,
  versionHash: string,
  config: BrainConfig,
  store: BrainStore,
): void {
  const candidateDir = path.join(config.skillsRoot, "candidates", name, versionHash);
  if (!fs.existsSync(candidateDir)) {
    throw new Error(`Candidate not found: ${name}/${versionHash}`);
  }

  const activeDir = path.join(config.skillsRoot, "active", name);

  // 1. Retire the current active version, if any.
  if (fs.existsSync(activeDir)) {
    const oldMeta = readMetadata(activeDir);
    const oldHash = oldMeta?.versionHash ?? "unknown";
    const retiredDir = path.join(config.skillsRoot, "retired", name, oldHash);
    fs.mkdirSync(path.dirname(retiredDir), { recursive: true });
    fs.cpSync(activeDir, retiredDir, { recursive: true });
    fs.rmSync(activeDir, { recursive: true, force: true });

    for (const ov of store.getActiveSkills().filter((s) => s.name === name)) {
      store.updateSkillStatus(ov.id, "retired");
    }
  }

  // 2. Copy the candidate into place as the new active version.
  fs.mkdirSync(activeDir, { recursive: true });
  fs.cpSync(candidateDir, activeDir, { recursive: true });

  const promotedAt = new Date().toISOString();
  const activeMeta = readMetadata(activeDir);
  if (activeMeta) {
    activeMeta.promotedAt = promotedAt;
    writeMetadata(activeDir, activeMeta);
  }

  // 3. Update the database.
  for (const c of store.getCandidateSkills().filter((s) => s.name === name && s.versionHash === versionHash)) {
    store.updateSkillStatus(c.id, "active", promotedAt);
  }

  // 4. Clean up the candidate directory (and its parent, if now empty).
  fs.rmSync(candidateDir, { recursive: true, force: true });
  const candidateParentDir = path.join(config.skillsRoot, "candidates", name);
  try {
    if (fs.readdirSync(candidateParentDir).length === 0) fs.rmdirSync(candidateParentDir);
  } catch {
    // not empty, or already gone — fine either way
  }
}

// ---------------------------------------------------------------------------
// rejectCandidate
// ---------------------------------------------------------------------------

/** Moves a candidate to `retired/{name}/{versionHash}/` and marks its
 * database row `rejected`. Unlike promotion, this never touches the active
 * version. */
export function rejectCandidate(
  name: string,
  versionHash: string,
  config: BrainConfig,
  store: BrainStore,
): void {
  const candidateDir = path.join(config.skillsRoot, "candidates", name, versionHash);
  if (!fs.existsSync(candidateDir)) {
    throw new Error(`Candidate not found: ${name}/${versionHash}`);
  }

  const retiredDir = path.join(config.skillsRoot, "retired", name, versionHash);
  fs.mkdirSync(path.dirname(retiredDir), { recursive: true });
  fs.cpSync(candidateDir, retiredDir, { recursive: true });
  fs.rmSync(candidateDir, { recursive: true, force: true });

  const candidateParentDir = path.join(config.skillsRoot, "candidates", name);
  try {
    if (fs.readdirSync(candidateParentDir).length === 0) fs.rmdirSync(candidateParentDir);
  } catch {
    // not empty, or already gone — fine either way
  }

  for (const c of store.getCandidateSkills().filter((s) => s.name === name && s.versionHash === versionHash)) {
    store.updateSkillStatus(c.id, "rejected");
  }
}

// ---------------------------------------------------------------------------
// rollbackSkill
// ---------------------------------------------------------------------------

/**
 * Rolls the active version of `name` back to its parent version. Returns
 * the restored `SkillVersion`, or `null` if there is no active version, no
 * recorded parent, or the parent's files are no longer in `retired/`.
 *
 * The current active version is moved to `retired/{name}/{currentHash}/`
 * (so a rollback can itself be rolled back) and the parent's files are
 * copied from `retired/` back into `active/{name}/`.
 */
export function rollbackSkill(
  name: string,
  config: BrainConfig,
  store: BrainStore,
): SkillVersion | null {
  const activeVersions = store.getActiveSkills().filter((s) => s.name === name);
  if (!activeVersions.length) return null;

  const current = activeVersions[0];
  if (!current.parentVersion) return null;

  const parentRetiredDir = path.join(config.skillsRoot, "retired", name, current.parentVersion);
  if (!fs.existsSync(parentRetiredDir)) return null;

  const activeDir = path.join(config.skillsRoot, "active", name);
  const currentRetiredDir = path.join(config.skillsRoot, "retired", name, current.versionHash);

  // Move the current active version into retired.
  fs.mkdirSync(path.dirname(currentRetiredDir), { recursive: true });
  fs.cpSync(activeDir, currentRetiredDir, { recursive: true });
  fs.rmSync(activeDir, { recursive: true, force: true });
  store.updateSkillStatus(current.id, "retired");

  // Restore the parent version from retired into active.
  fs.cpSync(parentRetiredDir, activeDir, { recursive: true });

  const parentRow = store.db
    .prepare("SELECT * FROM skill_versions WHERE name = ? AND version_hash = ?")
    .get(name, current.parentVersion) as
    | {
        id: string;
        name: string;
        version_hash: string;
        parent_version: string | null;
        status: string;
        source_procedure_ids: string | null;
        path: string;
        eval_run_id: string | null;
        created_at: string;
        promoted_at: string | null;
      }
    | undefined;

  if (!parentRow) return null;

  const promotedAt = new Date().toISOString();
  store.updateSkillStatus(parentRow.id, "active", promotedAt);

  return {
    id: parentRow.id,
    name: parentRow.name,
    versionHash: parentRow.version_hash,
    parentVersion: parentRow.parent_version,
    status: "active",
    sourceProcedureIds: parentRow.source_procedure_ids ? (JSON.parse(parentRow.source_procedure_ids) as string[]) : [],
    path: parentRow.path,
    evalRunId: parentRow.eval_run_id,
    createdAt: parentRow.created_at,
    promotedAt,
  };
}

// ---------------------------------------------------------------------------
// Filesystem listings
// ---------------------------------------------------------------------------

/** Lists active skills directly from the filesystem (not the database) —
 * this is what actually governs what Pi will discover. */
export function listActiveSkills(config: BrainConfig): Array<{ name: string; path: string }> {
  const dir = path.join(config.skillsRoot, "active");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
}

/** Lists candidate skill versions directly from the filesystem. */
export function listCandidates(config: BrainConfig): Array<{ name: string; versionHash: string; path: string }> {
  const dir = path.join(config.skillsRoot, "candidates");
  if (!fs.existsSync(dir)) return [];
  const results: Array<{ name: string; versionHash: string; path: string }> = [];
  for (const nameEntry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!nameEntry.isDirectory()) continue;
    const nameDir = path.join(dir, nameEntry.name);
    for (const hashEntry of fs.readdirSync(nameDir, { withFileTypes: true })) {
      if (!hashEntry.isDirectory()) continue;
      const hashDir = path.join(nameDir, hashEntry.name);
      if (fs.existsSync(path.join(hashDir, "SKILL.md"))) {
        results.push({ name: nameEntry.name, versionHash: hashEntry.name, path: hashDir });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Pi-native discovery
// ---------------------------------------------------------------------------

/** Paths to hand Pi's `resources_discover` as `skillPaths`. Only `active/`
 * is exposed — candidates and retired versions are never eligible for
 * discovery, so an unreviewed or superseded skill can never be picked up
 * by a running agent. */
export function getSkillDiscoverPaths(config: BrainConfig): string[] {
  return [path.join(config.skillsRoot, "active")];
}
