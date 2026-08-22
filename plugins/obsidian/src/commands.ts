import { App, Notice, Modal } from "obsidian";
import type WaywiserBrainPlugin from "./main";

export function registerBrainCommands(plugin: WaywiserBrainPlugin): void {
  // Refresh dashboard
  plugin.addCommand({
    id: "brain-refresh",
    name: "Brain: Refresh dashboard",
    callback: () => {
      plugin.dbReader?.reload();
      plugin.updateStatusBar();
      new Notice("Brain dashboard refreshed");
    },
  });

  // Show stats
  plugin.addCommand({
    id: "brain-stats",
    name: "Brain: Show statistics",
    callback: () => {
      if (!plugin.dbReader) {
        new Notice("Brain DB not connected");
        return;
      }
      const stats = plugin.dbReader.getStats();
      new Notice(
        `🧠 Brain: ${stats.memories.active} memories, ${stats.procedures.total} procedures, ${stats.skills.active} skills, ${stats.experiences} experiences`,
        10000,
      );
    },
  });

  // Open dashboard
  plugin.addCommand({
    id: "brain-dashboard",
    name: "Brain: Open dashboard",
    callback: () => {
      plugin.activateDashboard();
    },
  });

  // Show contradictions
  plugin.addCommand({
    id: "brain-contradictions",
    name: "Brain: Show contradictions",
    callback: () => {
      if (!plugin.dbReader) {
        new Notice("Brain DB not connected");
        return;
      }
      const contradictions = plugin.dbReader.getContradictions();
      if (!contradictions.length) {
        new Notice("No contradictions found");
        return;
      }
      new ContradictionsModal(plugin.app, contradictions).open();
    },
  });

  // Show evolution status
  plugin.addCommand({
    id: "brain-evolution",
    name: "Brain: Evolution status",
    callback: () => {
      if (!plugin.dbReader) {
        new Notice("Brain DB not connected");
        return;
      }
      const active = plugin.dbReader.getSkillVersions({ status: "active" });
      const candidates = plugin.dbReader.getSkillVersions({ status: "candidate" });
      const runs = plugin.dbReader.getEvolutionRuns(5);

      let msg = "🔄 Evolution Status\n";
      msg += `Active skills: ${active.length}\n`;
      for (const s of active) msg += `  ✅ ${s.name}\n`;
      msg += `Candidates: ${candidates.length}\n`;
      for (const s of candidates) msg += `  ⏳ ${s.name}\n`;
      msg += `Recent runs: ${runs.length}\n`;
      for (const r of runs) msg += `  ${r.status === "passed" ? "✅" : "❌"} ${r.id.slice(0, 12)} (${r.status})\n`;

      new Notice(msg, 15000);
    },
  });

  // Show recent activity
  plugin.addCommand({
    id: "brain-activity",
    name: "Brain: Recent activity",
    callback: () => {
      if (!plugin.dbReader) {
        new Notice("Brain DB not connected");
        return;
      }
      const logs = plugin.dbReader.getRecentLogs(10);
      if (!logs.length) {
        new Notice("No recent activity");
        return;
      }
      let msg = "📊 Recent Brain Activity\n";
      for (const log of logs) {
        const time = log.created_at.slice(11, 16);
        msg += `[${time}] ${log.kind}: ${log.details.slice(0, 50)}\n`;
      }
      new Notice(msg, 15000);
    },
  });

  // Navigate to memory by ID
  plugin.addCommand({
    id: "brain-goto-memory",
    name: "Brain: Go to memory file",
    callback: () => {
      if (!plugin.dbReader) {
        new Notice("Brain DB not connected");
        return;
      }
      new MemorySearchModal(plugin.app, plugin).open();
    },
  });
}

// ── Modals ──────────────────────────────────────────────────────────

class ContradictionsModal extends Modal {
  private contradictions: Array<{ details: string; created_at: string }>;

  constructor(app: App, contradictions: Array<{ details: string; created_at: string }>) {
    super(app);
    this.contradictions = contradictions;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "⚠️ Brain Contradictions" });

    for (const c of this.contradictions) {
      const div = contentEl.createEl("div", { cls: "brain-contradiction-modal-item" });
      try {
        const detail = JSON.parse(c.details);
        div.createEl("p", { text: `Memory #${detail.memA} vs Memory #${detail.memB}` });
        div.createEl("p", { cls: "brain-muted", text: `Reason: ${detail.reason || "unknown"}` });
        div.createEl("p", { cls: "brain-muted", text: `Suggested keep: #${detail.keepId || "undecided"}` });
      } catch {
        div.createEl("p", { text: c.details.slice(0, 200) });
      }
      div.createEl("p", { cls: "brain-muted", text: `Found: ${c.created_at}` });
      contentEl.createEl("hr");
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class MemorySearchModal extends Modal {
  private plugin: WaywiserBrainPlugin;

  constructor(app: App, plugin: WaywiserBrainPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "🧠 Go to Memory" });

    const memories = this.plugin.dbReader?.getMemories({ status: "active", limit: 30 }) ?? [];
    const list = contentEl.createEl("div", { cls: "brain-memory-search-list" });

    for (const m of memories) {
      const item = list.createEl("div", { cls: "brain-memory-search-item" });
      item.createEl("span", { cls: "brain-type-badge", text: `[${m.type}]` });
      item.createEl("span", { text: ` ${m.content.slice(0, 100)}` });
      item.addEventListener("click", () => {
        // Try to open the corresponding vault file
        const slug = m.type + "-" + m.content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60);
        const file = this.app.vault.getAbstractFileByPath(`semantic/${slug}.md`);
        if (file) {
          this.app.workspace.getLeaf().openFile(file as any);
        } else {
          new Notice(`File not found for memory #${m.id}`);
        }
        this.close();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
