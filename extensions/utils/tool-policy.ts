/**
 * Extensible tool risk classification for Waywiser plugins.
 *
 * Plugins register per-tool risk classifiers via registerToolRiskClassifier().
 * The permission system consults these BEFORE built-in classifiers, enabling
 * plugins to declare their own risk semantics without modifying core code.
 *
 * Blueprint §4.1: extensible classification for plugin tools.
 */
import type { RiskClass } from "../permissions.js";
import { registry_ } from "./state.js";

export type ToolRiskClassifier = (
	input: Record<string, unknown>,
) => RiskClass;

/**
 * Register a per-tool risk classifier. Returns an unregister function.
 * Throws if a classifier is already registered for the same tool name.
 */
export function registerToolRiskClassifier(
	toolName: string,
	classifier: ToolRiskClassifier,
): () => void {
	const reg = registry_();
	if (reg.toolRiskClassifiers.has(toolName)) {
		throw new Error(`Risk classifier already registered: ${toolName}`);
	}
	reg.toolRiskClassifiers.set(toolName, classifier);
	return () => {
		if (reg.toolRiskClassifiers.get(toolName) === classifier) {
			reg.toolRiskClassifiers.delete(toolName);
		}
	};
}
