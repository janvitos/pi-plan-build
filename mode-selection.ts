import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveSettings, SHORTCUT_CONFIG_FILE } from "./shortcut-config.ts";
import type { Mode } from "./utils.ts";

type Thinking = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export interface ModeSelection { provider: string; modelId: string; thinkingLevel: Thinking }
export interface ModeSelections { enabled: boolean; plan?: ModeSelection; build?: ModeSelection }
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function parseModeSelections(value: unknown): ModeSelections {
	if (value === undefined) return { enabled: false };
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("modeSelections must be an object");
	const raw = value as Record<string, unknown>;
	if (typeof raw.enabled !== "boolean") throw new Error("modeSelections.enabled must be a boolean");
	const result: ModeSelections = { enabled: raw.enabled };
	for (const mode of ["plan", "build"] as const) {
		if (raw[mode] === undefined) continue;
		const pair = raw[mode] as ModeSelection;
		if (!pair || typeof pair.provider !== "string" || !pair.provider.trim() || typeof pair.modelId !== "string" || !pair.modelId.trim() || !levels.has(pair.thinkingLevel)) throw new Error(`Invalid modeSelections.${mode}`);
		result[mode] = { provider: pair.provider, modelId: pair.modelId, thinkingLevel: pair.thinkingLevel };
	}
	return result;
}

/** Global defaults, not replacements for session-restored model choices. */
export function createModeSelections(pi: ExtensionAPI, agentDir: string, effectiveMode: () => Mode) {
	let config: ModeSelections = { enabled: false };
	let warning: string | undefined;
	try { config = parseModeSelections(JSON.parse(fs.readFileSync(path.join(agentDir, SHORTCUT_CONFIG_FILE), "utf8")).modeSelections); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warning = `Per-mode selections disabled: ${error instanceof Error ? error.message : String(error)}`; }
	let internal = 0;
	let routingTarget: ModeSelection | undefined;
	let userOverride: ModeSelection | undefined;
	let disposed = false;
	let queue: Promise<void> = Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let current: ModeSelection | undefined;
	let generation = 0;
	const capture = (ctx: ExtensionContext): ModeSelection | undefined => ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: pi.getThinkingLevel() } : undefined;
	function save(next: ModeSelections) {
		if (JSON.stringify(config) === JSON.stringify(next)) return;
		let merged = next;
		saveSettings(agentDir, document => {
			const latest = parseModeSelections(document.modeSelections); // Never erase malformed settings.
			merged = { ...latest };
			for (const key of ["enabled", "plan", "build"] as const) {
				if (JSON.stringify(config[key]) !== JSON.stringify(next[key])) Object.assign(merged, { [key]: next[key] });
			}
			return { ...document, modeSelections: merged };
		});
		config = merged;
	}
	function remember(pair: ModeSelection, ctx: ExtensionContext) {
		try { save({ ...config, [effectiveMode()]: pair }); }
		catch (error) { ctx.ui.notify(`Could not remember mode selection: ${String(error)}`, "warning"); }
	}
	return {
		get enabled() { return config.enabled; },
		get warning() { return warning; },
		get suppressed() { return internal > 0; },
		pair(mode: Mode) { return config.enabled ? config[mode] : undefined; },
		restore(ctx: ExtensionContext) {
			if (timer) { clearTimeout(timer); timer = undefined; }
			current = capture(ctx);
			if (config.enabled && current) remember(current, ctx);
		},
		setEnabled(enabled: boolean, ctx: ExtensionContext) {
			generation++;
			const pair = capture(ctx);
			save(enabled && pair ? { ...config, enabled, [effectiveMode()]: pair, [effectiveMode() === "plan" ? "build" : "plan"]: config[effectiveMode() === "plan" ? "build" : "plan"] ?? pair } : { ...config, enabled });
			current = pair;
		},
		changed(ctx: ExtensionContext, restore = false) {
			if (disposed || !config.enabled) return;
			if (internal) {
				const pair = capture(ctx);
				if (routingTarget && pair && (pair.provider !== routingTarget.provider || pair.modelId !== routingTarget.modelId)) { userOverride = pair; generation++; }
				return;
			}
			current = capture(ctx);
			if (restore) { if (timer) { clearTimeout(timer); timer = undefined; } return; }
			generation++;
			if (timer) clearTimeout(timer);
			// Model switches emit thinking changes first. Coalesce into the final actual pair.
			timer = setTimeout(() => { timer = undefined; if (!disposed && !internal && config.enabled) { const pair = capture(ctx); if (pair) remember(pair, ctx); } }, 0);
		},
		async suppress<T>(work: () => Promise<T>): Promise<T> { internal++; try { return await work(); } finally { internal--; } },
		async apply(mode: Mode, ctx: ExtensionContext): Promise<void> {
			if (!config.enabled || disposed) return;
			if (timer) { clearTimeout(timer); timer = undefined; const pair = capture(ctx); if (pair) remember(pair, ctx); }
			const ticket = ++generation;
			const run = queue.then(async () => {
				if (ticket !== generation || disposed || !config.enabled) return;
				const target = config[mode];
				if (!target) { const pair = capture(ctx); if (pair) save({ ...config, [mode]: pair }); return; }
				const model = ctx.modelRegistry.find(target.provider, target.modelId);
				if (!model) throw new Error(`Remembered ${mode} model ${target.provider}/${target.modelId} is unavailable. Select a replacement or disable per-mode selection.`);
				internal++;
				routingTarget = target;
				userOverride = undefined;
				try {
					if (!current || current.provider !== target.provider || current.modelId !== target.modelId) {
						if (!await pi.setModel(model)) throw new Error(`No authentication for remembered ${mode} model ${target.provider}/${target.modelId}.`);
						current = { provider: target.provider, modelId: target.modelId, thinkingLevel: pi.getThinkingLevel() };
					}
					if (disposed) return;
					if (userOverride) {
						const choice = userOverride;
						routingTarget = undefined;
						const chosen = ctx.modelRegistry.find(choice.provider, choice.modelId);
						if (chosen && await pi.setModel(chosen)) pi.setThinkingLevel(choice.thinkingLevel);
						current = choice;
						remember(choice, ctx);
						throw new Error("Model selection changed during mode switching. Your choice was preserved; retry the mode switch.");
					}
					if (ticket !== generation) return;
					pi.setThinkingLevel(target.thinkingLevel);
					current = { ...target, thinkingLevel: pi.getThinkingLevel() };
					if (current.thinkingLevel !== target.thinkingLevel) {
						ctx.ui.notify(`${mode} thinking adjusted to ${current.thinkingLevel} for this model.`, "warning");
						save({ ...config, [mode]: current });
					}
				} finally { routingTarget = undefined; userOverride = undefined; internal--; }
			});
			queue = run.catch(() => {});
			return run;
		},
		dispose() { disposed = true; generation++; if (timer) clearTimeout(timer); },
	};
}
