import { ItemView, WorkspaceLeaf } from "obsidian";
import type { BrainDBReader } from "./db-reader";
import type { BrainStats } from "./types";

export const BRAIN_VIEW_TYPE = "brain-dashboard";

export class BrainDashboardView extends ItemView {
  private dbReader: BrainDBReader | null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(leaf: WorkspaceLeaf, dbReader: BrainDBReader | null) {
    super(leaf);
    this.dbReader = dbReader;
  }

  getViewType(): string {
    return BRAIN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Brain Dashboard";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    this.render();
    // Auto-refresh every 5 seconds
    this.refreshTimer = setInterval(() => this.render(), 5000);
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  setDbReader(reader: BrainDBReader | null): void {
    this.dbReader = reader;
    this.render();
  }

  render(): void {
    const container = this.containerEl.children[1];
    container.empty();

    if (!this.dbReader) {
      container.createEl("div", {
        cls: "brain-dashboard brain-no-db",
        text: "Brain database not found. Configure the path in settings.",
      });
      return;
    }

    const root = container.createEl("div", { cls: "brain-dashboard" });

    // Header
    root.createEl("h2", { text: "🧠 Waywiser Brain" });

    // Stats grid
    const stats = this.dbReader.getStats();
    this.renderStats(root, stats);

    // Contradictions
    this.renderContradictions(root);

    // Evolution
    this.renderEvolution(root);

    // Recent Memories
    this.renderMemories(root);

    // Procedures
    this.renderProcedures(root);

    // Activity Log
    this.renderActivity(root);
  }

  private renderStats(root: HTMLElement, stats: BrainStats): void {
    const grid = root.createEl("div", { cls: "brain-stat-grid" });

    const memCard = grid.createEl("div", { cls: "brain-stat-card" });
    memCard.createEl("div", { cls: "stat-value", text: String(stats.memories.active) });
    memCard.createEl("div", { cls: "stat-label", text: "Memories" });

    const procCard = grid.createEl("div", { cls: "brain-stat-card" });
    procCard.createEl("div", { cls: "stat-value", text: String(stats.procedures.total) });
    procCard.createEl("div", { cls: "stat-label", text: "Procedures" });

    const skillCard = grid.createEl("div", { cls: "brain-stat-card" });
    skillCard.createEl("div", { cls: "stat-value", text: String(stats.skills.active) });
    skillCard.createEl("div", { cls: "stat-label", text: "Skills" });

    const expCard = grid.createEl("div", { cls: "brain-stat-card" });
    expCard.createEl("div", { cls: "stat-value", text: String(stats.experiences) });
    expCard.createEl("div", { cls: "stat-label", text: "Experiences" });
  }

  private renderContradictions(root: HTMLElement): void {
    const contradictions = this.dbReader!.getContradictions();
    if (!contradictions.length) return;

    const section = root.createEl("div", { cls: "brain-section" });
    section.createEl("h3", { text: `⚠️ Contradictions (${contradictions.length})` });
    const list = section.createEl("ul", { cls: "brain-contradiction-list" });
    for (const c of contradictions.slice(0, 5)) {
      try {
        const detail = JSON.parse(c.details);
        list.createEl("li", {
          text: `mem#${detail.memA} vs mem#${detail.memB}: ${detail.reason || "pending review"}`,
        });
      } catch {
        list.createEl("li", { text: c.details.slice(0, 100) });
      }
    }
  }

  private renderEvolution(root: HTMLElement): void {
    const section = root.createEl("div", { cls: "brain-section" });
    section.createEl("h3", { text: "🔄 Evolution" });

    const active = this.dbReader!.getSkillVersions({ status: "active" });
    const candidates = this.dbReader!.getSkillVersions({ status: "candidate" });

    if (!active.length && !candidates.length) {
      section.createEl("p", { cls: "brain-muted", text: "No evolved skills yet." });
      return;
    }

    const list = section.createEl("ul", { cls: "brain-evolution-list" });
    for (const s of active) {
      list.createEl("li", { text: `✅ ${s.name} (active, ${s.version_hash.slice(0, 12)})` });
    }
    for (const s of candidates) {
      list.createEl("li", { text: `⏳ ${s.name} (candidate)` });
    }
  }

  private renderMemories(root: HTMLElement): void {
    const section = root.createEl("div", { cls: "brain-section" });
    section.createEl("h3", { text: "📝 Recent Memories" });

    const memories = this.dbReader!.getMemories({ status: "active", limit: 10 });
    if (!memories.length) {
      section.createEl("p", { cls: "brain-muted", text: "No memories yet." });
      return;
    }

    const list = section.createEl("ul", { cls: "brain-memory-list" });
    for (const m of memories) {
      const conf = m.confidence >= 0.8 ? "high" : m.confidence >= 0.5 ? "medium" : "low";
      const item = list.createEl("li", { cls: "brain-memory-item" });
      item.dataset.confidence = conf;
      item.createEl("span", { cls: "brain-type-badge", text: `[${m.type}]` });
      item.createEl("span", { text: ` ${m.content.slice(0, 80)}${m.content.length > 80 ? "…" : ""}` });
      item.createEl("span", { cls: "brain-confidence", text: ` (${m.confidence.toFixed(2)})` });
    }
  }

  private renderProcedures(root: HTMLElement): void {
    const section = root.createEl("div", { cls: "brain-section" });
    section.createEl("h3", { text: "⚙️ Procedures" });

    const procedures = this.dbReader!.getProcedures({ limit: 10 });
    if (!procedures.length) {
      section.createEl("p", { cls: "brain-muted", text: "No procedures yet." });
      return;
    }

    const statusIcon: Record<string, string> = {
      mature: "🟢", reinforced: "🔵", tentative: "⚪", contradicted: "🔴", retired: "⚫",
    };

    const list = section.createEl("ul", { cls: "brain-procedure-list" });
    for (const p of procedures) {
      const item = list.createEl("li", { cls: "brain-procedure-item" });
      item.dataset.status = p.status;
      item.createEl("span", { text: `${statusIcon[p.status] || "⚪"} ${p.key}` });
      item.createEl("span", { cls: "brain-muted", text: ` (${p.status}, ${p.success_count}✓ ${p.failure_count}✗)` });
    }
  }

  private renderActivity(root: HTMLElement): void {
    const section = root.createEl("div", { cls: "brain-section" });
    section.createEl("h3", { text: "📊 Activity" });

    const logs = this.dbReader!.getRecentLogs(8);
    if (!logs.length) {
      section.createEl("p", { cls: "brain-muted", text: "No activity yet." });
      return;
    }

    const list = section.createEl("ul", { cls: "brain-activity-list" });
    for (const log of logs) {
      const time = log.created_at.slice(11, 16); // HH:MM
      list.createEl("li", {
        cls: "brain-activity-item",
        text: `[${time}] ${log.kind}: ${log.details.slice(0, 60)}`,
      });
    }
  }
}
