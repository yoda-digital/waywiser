import { Plugin } from "obsidian";
import { BrainDBReader } from "./db-reader";
import { DBWatcher } from "./watcher";
import { BrainSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type WaywiserBrainSettings } from "./types";

export default class WaywiserBrainPlugin extends Plugin {
  settings: WaywiserBrainSettings = DEFAULT_SETTINGS;
  dbReader: BrainDBReader | null = null;
  watcher: DBWatcher | null = null;
  statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Settings tab
    this.addSettingTab(new BrainSettingTab(this.app, this));

    // Resolve DB path
    const dbPath = this.resolveDbPath();
    if (dbPath) {
      this.dbReader = new BrainDBReader(dbPath);
      try {
        await this.dbReader.open();
      } catch (e) {
        console.error("Waywiser Brain: failed to open DB:", e);
        this.dbReader = null;
      }
    }

    // Status bar
    if (this.settings.showStatusBar) {
      this.statusBarEl = this.addStatusBarItem();
      this.updateStatusBar();
    }

    // File watcher
    if (this.settings.autoRefresh && dbPath) {
      this.startWatcher(dbPath);
    }

    // Register views, commands, and graph hooks in Tasks 24-25
    console.log("Waywiser Brain plugin loaded");
  }

  onunload(): void {
    this.watcher?.stop();
    this.dbReader?.close();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  resolveDbPath(): string | null {
    if (this.settings.dbPath) return this.settings.dbPath;

    // Auto-detect: look for brain.db or waywiser.db in common locations
    const { existsSync } = require("fs");
    const { join } = require("path");
    const home = process.env.HOME || process.env.USERPROFILE || "";

    const candidates = [
      join(home, ".waywiser", "waywiser.db"),
      join(home, ".waywiser", "brain.db"),
    ];

    // Also check if the vault itself contains a .brain.db
    const vaultPath = (this.app.vault.adapter as any).basePath;
    if (vaultPath) {
      candidates.unshift(join(vaultPath, ".brain.db"));
    }

    for (const p of candidates) {
      if (existsSync(p)) return p;
    }

    return null;
  }

  startWatcher(dbPath: string): void {
    this.watcher?.stop();
    this.watcher = new DBWatcher(dbPath, this.settings.refreshIntervalMs, () => {
      this.dbReader?.reload();
      this.updateStatusBar();
      // Will also refresh views in Task 24
    });
    this.watcher.start();
  }

  restartWatcher(): void {
    const dbPath = this.resolveDbPath();
    if (dbPath && this.settings.autoRefresh) {
      this.startWatcher(dbPath);
    } else {
      this.watcher?.stop();
    }
  }

  updateStatusBar(): void {
    if (!this.statusBarEl || !this.dbReader) return;
    const stats = this.dbReader.getStats();
    this.statusBarEl.setText(
      `🧠 ${stats.memories.active}m ${stats.procedures.mature}p${stats.skills.active ? ` ${stats.skills.active}s` : ""}`
    );
  }
}
