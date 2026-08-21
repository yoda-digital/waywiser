import { MarkdownPostProcessorContext, Plugin } from "obsidian";

export function registerGraphIntegration(plugin: Plugin): void {
  // Graph view CSS-based coloring works through cssclasses in frontmatter.
  // The vault.ts Tier 1 enhancement already adds:
  //   cssclasses: [brain-memory, brain-active] or [brain-procedure, brain-mature]
  //
  // We provide CSS rules that target these in the graph view.
  // Obsidian's graph view assigns CSS classes based on file paths and tags,
  // so our styling works through the tag-based color groups feature.

  // Register a markdown post-processor to add visual enhancements
  plugin.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    // Add confidence indicators to rendered brain files
    const frontmatter = ctx.frontmatter;
    if (!frontmatter) return;

    // Only process brain files
    const tags = frontmatter.tags;
    if (!Array.isArray(tags) || !tags.some((t: string) => typeof t === "string" && t.startsWith("brain/"))) return;

    // Add a confidence indicator bar at the top
    const confidence = frontmatter.confidence;
    if (typeof confidence === "number") {
      const indicator = el.createEl("div", { cls: "brain-confidence-bar" });
      const fill = indicator.createEl("div", { cls: "brain-confidence-fill" });
      fill.style.width = `${Math.round(confidence * 100)}%`;
      fill.style.backgroundColor = confidence >= 0.8 ? "var(--color-green)" : confidence >= 0.5 ? "var(--color-yellow)" : "var(--color-red)";
      el.prepend(indicator);
    }

    // Add status badge
    const status = frontmatter.status;
    if (status) {
      const badge = el.createEl("div", { cls: `brain-status-badge brain-status-${status}` });
      badge.setText(String(status).toUpperCase());
      el.prepend(badge);
    }
  });
}
