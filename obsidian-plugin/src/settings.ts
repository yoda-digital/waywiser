import { App, PluginSettingTab, Setting } from "obsidian";
import type WaywiserBrainPlugin from "./main";

export class BrainSettingTab extends PluginSettingTab {
  plugin: WaywiserBrainPlugin;

  constructor(app: App, plugin: WaywiserBrainPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Waywiser Brain Settings" });

    new Setting(containerEl)
      .setName("Database path")
      .setDesc("Path to brain.db (leave empty to auto-detect from vault)")
      .addText(text => text
        .setPlaceholder("~/.waywiser/waywiser.db")
        .setValue(this.plugin.settings.dbPath)
        .onChange(async (value) => {
          this.plugin.settings.dbPath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Auto-refresh")
      .setDesc("Automatically refresh when brain.db changes")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoRefresh)
        .onChange(async (value) => {
          this.plugin.settings.autoRefresh = value;
          await this.plugin.saveSettings();
          this.plugin.restartWatcher();
        }));

    new Setting(containerEl)
      .setName("Refresh interval")
      .setDesc("How often to check for DB changes (milliseconds)")
      .addText(text => text
        .setValue(String(this.plugin.settings.refreshIntervalMs))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num) && num >= 1000) {
            this.plugin.settings.refreshIntervalMs = num;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName("Status bar")
      .setDesc("Show brain status in the status bar")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showStatusBar)
        .onChange(async (value) => {
          this.plugin.settings.showStatusBar = value;
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar();
        }));

    new Setting(containerEl)
      .setName("Graph coloring")
      .setDesc("Color graph nodes by memory confidence/procedure status")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.graphColoring)
        .onChange(async (value) => {
          this.plugin.settings.graphColoring = value;
          await this.plugin.saveSettings();
        }));
  }
}
