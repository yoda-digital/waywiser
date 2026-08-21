export interface BrainMemory {
  id: number;
  type: string;
  content: string;
  confidence: number;
  source: string;
  scope: string;
  project_key: string | null;
  status: string;
  tags: string;
  created_at: string;
  last_accessed: string;
  access_count: number;
  useful_count: number;
  not_useful_count: number;
}

export interface Procedure {
  id: string;
  key: string;
  trigger_text: string;
  avoid_text: string | null;
  prefer_text: string | null;
  confidence: number;
  success_count: number;
  failure_count: number;
  status: string;
  scope: string;
  project_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillVersion {
  id: string;
  name: string;
  version_hash: string;
  parent_version: string | null;
  status: string;
  source_procedure_ids: string;
  path: string;
  eval_run_id: string | null;
  created_at: string;
  promoted_at: string | null;
}

export interface EvolutionRun {
  id: string;
  skill_version_id: string;
  baseline_version_id: string | null;
  status: string;
  result_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface BrainStats {
  memories: { active: number; frozen: number; archived: number; total: number };
  procedures: { tentative: number; reinforced: number; mature: number; contradicted: number; total: number };
  skills: { active: number; candidates: number; total: number };
  experiences: number;
  lastExperience: string | null;
  lastLearning: string | null;
}

export interface WaywiserBrainSettings {
  dbPath: string;
  autoRefresh: boolean;
  refreshIntervalMs: number;
  showStatusBar: boolean;
  graphColoring: boolean;
}

export const DEFAULT_SETTINGS: WaywiserBrainSettings = {
  dbPath: "",  // auto-detected from vault
  autoRefresh: true,
  refreshIntervalMs: 5000,
  showStatusBar: true,
  graphColoring: true,
};
