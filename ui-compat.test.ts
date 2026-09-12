import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { CombinedAutocompleteProvider, matchesKey } from "@earendil-works/pi-tui";
import planBuildModes from "./index.ts";
import { eventHandlers } from "./test-events.ts";
import { loadShortcutConfig, SHORTCUT_CONFIG_FILE } from "./shortcut-config.ts";

let agentDir: string;
let previousAgentDir: string | undefined;
const runningHarnesses = new Set<ReturnType<typeof createHarness>>();
beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-build-ui-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(async () => {
	try {
		for (const harness of runningHarnesses) await shutdown(harness);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

function createHarness(initialEditor?: unknown, entries: any[] = []) {
	const { handlers, on } = eventHandlers();
	const registeredTools = new Map<string, any>();
	let currentEditor = initialEditor;
	const editorCalls: unknown[] = [];
	let createdEditor: any;
	const statuses: Array<[string, string | undefined]> = [];
	const notifications: Array<[string, string]> = [];
	const shortcuts = new Map<string, any>();
	const commands = new Map<string, any>();
	const selections: Array<{ title: string; options: string[] }> = [];
	let selectedOption: string | undefined;
	let selectionQueue: Array<string | undefined> | undefined;
	let resolvePersist: ((data: any) => boolean) | undefined;
	const persisted: any[] = [];
	let activeTools = ["read", "bash", "edit", "write"];
	const tui = {
		requestRender() {},
		terminal: { columns: 160, rows: 40 },
	};
	const editorTheme = {
		borderColor: (text: string) => text,
		selectList: {},
	};
	let nativeThinkingCalls = 0;
	let historyUsesThinkingKey = false;
	const keybindings = {
		matches: (data: string, action: string) => matchesKey(data, "shift+tab") &&
			(action === "app.thinking.cycle" || historyUsesThinkingKey && action === "tui.editor.historyPrevious"),
	};
	const pi = {
		on,
		registerFlag() {},
		registerTool(definition: any) { registeredTools.set(definition.name, definition); },
		registerCommand(name: string, options: unknown) { commands.set(name, options); },
		registerShortcut(key: string, options: unknown) { shortcuts.set(key, options); },
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		getFlag() { return false; },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(next: string[]) { activeTools = [...next]; },
		appendEntry(_type: string, data: unknown) {
			persisted.push(data);
			if (resolvePersist?.(data)) resolvePersist = undefined;
		},
		getThinkingLevel() { return "medium"; },
	};
	const ctx = {
		mode: "tui",
		cwd: "/tmp/project",
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionId: () => "ui-compat-test",
		},
		ui: {
			getEditorComponent: () => currentEditor,
			setEditorComponent(factory: unknown) {
				editorCalls.push(factory);
				currentEditor = factory;
				if (typeof factory === "function") {
					createdEditor = factory(tui, editorTheme, keybindings);
					// Pi also copies native application handlers into CustomEditor instances.
					createdEditor.onAction("app.thinking.cycle", () => { nativeThinkingCalls++; });
					// Pi wires this callback onto custom editors after constructing them.
					createdEditor.onExtensionShortcut = (data: string) => {
						for (const [key, shortcut] of shortcuts) {
							if (!matchesKey(data, key as any)) continue;
							void shortcut.handler(ctx);
							return true;
						}
						return false;
					};
				}
			},
			setStatus(key: string, text: string | undefined) { statuses.push([key, text]); },
			notify(message: string, level: string) { notifications.push([message, level]); },
			async select(title: string, options: string[]) {
				selections.push({ title, options });
				return selectionQueue ? selectionQueue.shift() : selectedOption;
			},
			theme: {
				bold: (text: string) => `**${text}**`,
				fg: (_color: string, text: string) => text,
			},
		},
	};
	planBuildModes(pi as any);
	return {
		handlers,
		ctx,
		editorCalls,
		statuses,
		notifications,
		shortcuts,
		registeredTools,
		commands,
		selections,
		persisted,
		selectOption(value: string | undefined) { selectedOption = value; },
		selectOptions(...values: Array<string | undefined>) { selectionQueue = values; },
		nextPersist: (mode: string) => new Promise<void>((resolve) => {
			resolvePersist = (data) => {
				if (data.selectedMode !== mode) return false;
				resolve();
				return true;
			};
		}),
		editor: () => createdEditor,
		nativeThinkingCalls: () => nativeThinkingCalls,
		useThinkingKeyForHistory() { historyUsesThinkingKey = true; },
		setCurrentEditor(value: unknown) { currentEditor = value; },
		decorateCurrentEditor() {
			const base = currentEditor as ((...args: any[]) => unknown) | undefined;
			assert.equal(typeof base, "function");
			ctx.ui.setEditorComponent((...args: any[]) => base!(...args));
		},
	};
}

async function start(harness: ReturnType<typeof createHarness>) {
	runningHarnesses.add(harness);
	await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
}

async function shutdown(harness: ReturnType<typeof createHarness>) {
	await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
	runningHarnesses.delete(harness);
}

function writeConfig(value: unknown): void {
	fs.writeFileSync(path.join(agentDir, SHORTCUT_CONFIG_FILE), JSON.stringify(value));
}

async function toggle(harness: ReturnType<typeof createHarness>, data: string, expected: string) {
	const persisted = harness.nextPersist(expected);
	harness.editor().handleInput(data);
	await persisted;
	assert.equal(harness.persisted.at(-1).selectedMode, expected);
}

async function completeFile(harness: ReturnType<typeof createHarness>) {
	fs.writeFileSync(path.join(agentDir, "README.md"), "");
	fs.writeFileSync(path.join(agentDir, "README.txt"), "");
	const editor = harness.editor();
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], agentDir));
	editor.setText("Review READ");
	assert.equal(editor.isShowingAutocomplete(), false);
	editor.handleInput("\t");
	await editor.autocompleteRequestTask;
	assert.equal(editor.isShowingAutocomplete(), true, "Tab must request file suggestions from a closed menu");
	editor.handleInput("\t");
	assert.match(editor.getText(), /^Review README\.(md|txt)\s*$/);
	assert.equal(editor.isShowingAutocomplete(), false);
	assert.equal(harness.persisted.at(-1)?.selectedMode ?? "build", "build");
}

test("startup resume restores the latest active-branch history while empty startup stays empty", async () => {
	const entries = Array.from({ length: 105 }, (_, index) => ({ type: "message", message: { role: "user", content: `Prompt ${index}` } }));
	entries.push({ type: "message", message: { role: "assistant", content: "Not user history" } });
	const h = createHarness(undefined, entries);
	await start(h);
	for (let index = 104; index >= 5; index--) {
		h.editor().handleInput("\x1b[A");
		assert.equal(h.editor().getText(), `Prompt ${index}`);
	}
	h.editor().handleInput("\x1b[A");
	assert.equal(h.editor().getText(), "Prompt 5", "older than the latest 100 is excluded");
	await shutdown(h);
	const empty = createHarness();
	await start(empty);
	empty.editor().handleInput("\x1b[A");
	assert.equal(empty.editor().getText(), "");
});

test("delegates thinking to native handlers with extension and history precedence", async () => {
	const harness = createHarness();
	await start(harness);
	const editor = harness.editor();
	editor.handleInput("\x1b[Z");
	assert.equal(harness.nativeThinkingCalls(), 1);
	assert.equal(harness.persisted.length, 0, "native thinking does not change Plan/Build state");
	const shortcut = editor.onExtensionShortcut;
	editor.onExtensionShortcut = () => true;
	editor.handleInput("\x1b[Z");
	assert.equal(harness.nativeThinkingCalls(), 1, "extension shortcuts retain priority");
	editor.onExtensionShortcut = shortcut;
	harness.useThinkingKeyForHistory();
	editor.handleInput("\x1b[Z");
	assert.equal(harness.nativeThinkingCalls(), 1, "explicit history bindings bypass app actions");
});

test("registers default Alt+M without taking Pi's Shift+Tab thinking shortcut", () => {
	const harness = createHarness();
	assert.equal(harness.shortcuts.has("alt+m"), true);
	assert.equal(harness.shortcuts.has("ctrl+tab"), false);
	assert.equal(harness.shortcuts.has("shift+tab"), false);
});

test("default Tab and Alt+M toggle modes while an open menu retains completion", { timeout: 5000 }, async () => {
	const harness = createHarness();
	await start(harness);
	await toggle(harness, "\t", "plan");
	await toggle(harness, "\x1bm", "build");

	const editor = harness.editor();
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "plan" }, { name: "plant" }], agentDir));
	editor.handleInput("/");
	await editor.autocompleteRequestTask;
	assert.equal(editor.isShowingAutocomplete(), true);
	editor.handleInput("\t");
	assert.match(editor.getText(), /^\/plan\s*$/);
	assert.equal(editor.isShowingAutocomplete(), false);
	assert.equal(harness.persisted.at(-1).selectedMode, "build");
});

test("Alt+M only restores Tab-triggered file completion", { timeout: 5000 }, async () => {
	writeConfig({ shortcuts: { toggleModeInEditor: [] } });
	const harness = createHarness();
	await start(harness);
	await completeFile(harness);
	await toggle(harness, "\x1bm", "plan");
});

test("custom global and editor shortcuts dispatch, while old bindings are absent", { timeout: 5000 }, async () => {
	writeConfig({ shortcuts: { toggleMode: "ctrl+alt+m", toggleModeInEditor: ["f6"] } });
	const harness = createHarness();
	await start(harness);
	assert.deepEqual([...harness.shortcuts.keys()], ["ctrl+alt+m"]);
	await toggle(harness, "\x1b\r", "plan");
	await toggle(harness, "\x1b[17~", "build");
	await completeFile(harness);
});

test("disabled shortcuts register nothing and leave Tab completion intact", async () => {
	writeConfig({ shortcuts: { toggleMode: [], toggleModeInEditor: [] } });
	const harness = createHarness();
	await start(harness);
	assert.equal(harness.shortcuts.size, 0);
	await completeFile(harness);
});

test("global Tab is rejected with editor-only guidance and autocomplete remains usable", async () => {
	writeConfig({ shortcuts: { toggleMode: "tab", toggleModeInEditor: [] } });
	const harness = createHarness();
	await start(harness);
	assert.deepEqual([...harness.shortcuts.keys()], ["alt+m"]);
	assert.match(harness.notifications[0]![0], /put tab in shortcuts\.toggleModeInEditor/);
	await completeFile(harness);
});

test("plan title visibility persists through settings and reload without composer validation labels", async () => {
	const setup = async () => {
		const h = createHarness();
		await start(h);
		await h.commands.get("plan").handler("", h.ctx);
		await h.registeredTools.get("plan_task").execute("title", { action: "new", expectedAttached: null, title: "Plan Title", scope: "Test title appearance" }, undefined, undefined, h.ctx);
		h.editor().setText("Regular User Text");
		return h;
	};
	const h = await setup();
	assert.doesNotMatch(h.editor().render(100)[0], /plan title/);
	assert.match(JSON.stringify(h.persisted), /"title":"Plan Title"/);
	assert.equal(h.editor().getText(), "Regular User Text");
	h.selectOptions("Plan title (active: off)", undefined);
	await h.commands.get("plan-settings").handler("", h.ctx);
	assert.equal(fs.existsSync(path.join(agentDir, SHORTCUT_CONFIG_FILE)), false);
	let current = h;
	for (const enabled of [true, false]) {
		current.selectOptions(`Plan title (active: ${enabled ? "off" : "on"})`, enabled ? "On" : "Off (default)");
		await current.commands.get("plan-settings").handler("", current.ctx);
		assert.equal(loadShortcutConfig(agentDir).showPlanTitle, enabled);
		assert.deepEqual(current.notifications.at(-1), [`Plan title ${enabled ? "on" : "off"}.`, "info"]);
		if (enabled) assert.match(current.editor().render(100)[0], /plan title/);
		else assert.ok(!current.statuses.at(-1)?.[1]?.includes("Plan Title"));
		const reloaded = await setup();
		const lines = reloaded.editor().render(100);
		assert.equal(lines[0].includes("plan title"), enabled);
		assert.equal(lines.at(-1), h.editor().render(100).at(-1));
		assert.equal(reloaded.editor().getText(), "Regular User Text");
		await reloaded.commands.get("build").handler("", reloaded.ctx);
		await reloaded.registeredTools.get("plan_finish").execute("finish", { expectedAttached: 1, outcome: "awaiting_validation", reason: "Needs observation", userAction: "Check the title" }, undefined, undefined, reloaded.ctx);
		assert.doesNotMatch(reloaded.editor().render(100)[0], /validation/i);
		reloaded.setCurrentEditor({});
		await reloaded.handlers.get("before_agent_start")?.({}, reloaded.ctx);
		assert.doesNotMatch(reloaded.statuses.at(-1)?.[1] ?? "", /validation/i);
		assert.equal((reloaded.statuses.at(-1)?.[1] ?? "").includes("Plan Title"), enabled);
		current = reloaded;
	}
	const titleGuidance = h.registeredTools.get("plan_task").promptGuidelines.join(" ");
	assert.match(titleGuidance, /imperative, single-action title/);
	assert.match(titleGuidance, /detailed scope/);
	assert.match(titleGuidance, /Add color to the composer/);
	assert.doesNotMatch(titleGuidance, /3–6 words/);
	assert.match(h.registeredTools.get("plan_task").parameters.properties.title.description, /One imperative phrase naming the action/);
	h.setCurrentEditor({});
	await h.handlers.get("before_agent_start")?.({}, h.ctx);
	assert.ok(h.statuses.at(-1)?.[1]?.includes("Plan Title"), "the live enabled preference applies to reduced UI too");
});

test("settings group shortcut presets in a submenu, retain active bindings until reload, and reload correctly", async () => {
	const harness = createHarness();
	await start(harness);
	harness.selectOptions("Shortcuts (active: Tab + Alt+M)", "Alt+M only");
	await harness.commands.get("plan-settings").handler("", harness.ctx);
	assert.equal(harness.selections[0]!.title, "Plan/Build settings");
	assert.deepEqual(harness.selections[0]!.options, ["Default mode (active: build)", "Shortcuts (active: Tab + Alt+M)", "Plan title (active: off)", "Per-mode model/thinking (active: off)"]);
	assert.match(harness.selections[1]!.title, /active: Tab \+ Alt\+M/);
	assert.deepEqual(harness.selections[1]!.options, ["Tab + Alt+M", "Alt+M only", "Disabled", "Custom (edit config file)"]);
	assert.match(harness.notifications.at(-1)![0], /Saved Alt\+M only.*\/reload/);
	await toggle(harness, "\t", "plan");
	await shutdown(harness);

	const reloaded = createHarness();
	await start(reloaded);
	await completeFile(reloaded);
	reloaded.selectOptions("Shortcuts (active: Alt+M only)", "Disabled");
	await reloaded.commands.get("plan-settings").handler("", reloaded.ctx);
	assert.match(reloaded.selections[1]!.title, /active: Alt\+M only/);
	assert.deepEqual(loadShortcutConfig(agentDir).config, { toggleMode: [], toggleModeInEditor: [] });
});

test("settings cancellation and custom guidance do not create or overwrite configuration", async () => {
	const harness = createHarness();
	const command = harness.commands.get("plan-settings");
	await command.handler("", harness.ctx);
	assert.equal(fs.existsSync(path.join(agentDir, SHORTCUT_CONFIG_FILE)), false);
	writeConfig({ shortcuts: { toggleMode: "f6", toggleModeInEditor: [] }, unrelated: true });
	const before = fs.readFileSync(path.join(agentDir, SHORTCUT_CONFIG_FILE), "utf8");
	harness.selectOptions("Shortcuts (active: Tab + Alt+M)", "Custom (edit config file)");
	await command.handler("", harness.ctx);
	assert.ok(harness.notifications.at(-1)![0].includes(path.join(agentDir, SHORTCUT_CONFIG_FILE)));
	assert.match(harness.notifications.at(-1)![0], /toggleModeInEditor.*file completion/);
	assert.equal(fs.readFileSync(path.join(agentDir, SHORTCUT_CONFIG_FILE), "utf8"), before);
});

test("settings report a failed save without overwriting malformed JSON", async () => {
	const configPath = path.join(agentDir, SHORTCUT_CONFIG_FILE);
	fs.writeFileSync(configPath, "{");
	const harness = createHarness();
	harness.selectOptions("Shortcuts (active: Tab + Alt+M)", "Alt+M only");
	await harness.commands.get("plan-settings").handler("", harness.ctx);
	assert.equal(harness.notifications.at(-1)![1], "error");
	assert.match(harness.notifications.at(-1)![0], /Could not save/);
	assert.equal(fs.readFileSync(configPath, "utf8"), "{");
});

test("exposes plan_exit in the textual tool inventory metadata", () => {
	const harness = createHarness();
	const planExit = harness.registeredTools.get("plan_exit");

	assert.equal(planExit?.promptSnippet, "Display the saved plan and request user approval");
	assert.deepEqual(planExit?.promptGuidelines, [
		"Call plan_exit only after finalizing the saved plan for review.",
	]);
});

test("model-facing tool metadata keeps schemas stable and prompt overhead bounded", () => {
	const harness = createHarness();
	const metadataSize = (names: string[]) => names.reduce((size, name) => {
		const tool = harness.registeredTools.get(name);
		assert.ok(tool, `missing registered tool ${name}`);
		return size + JSON.stringify({
			name: tool.name,
			description: tool.description,
			promptSnippet: tool.promptSnippet,
			promptGuidelines: tool.promptGuidelines,
			parameters: tool.parameters,
		}).length;
	}, 0);
	assert.equal(harness.registeredTools.has("plan_enter"), false);
	const sets = {
		plan: ["question", "plan_exit", "plan_task"],
		buildWithoutPlan: ["question", "plan_task"],
		buildWithPlan: ["question", "plan_task", "plan_complete", "plan_finish"],
		activeStep: ["question", "plan_task", "plan_finish", "plan_step_control", "plan_step_complete"],
	};
	assert.ok(metadataSize(sets.plan) <= 3500);
	assert.ok(metadataSize(sets.buildWithoutPlan) <= 2900);
	assert.ok(metadataSize(sets.buildWithPlan) <= 4900);
	assert.ok(metadataSize(sets.activeStep) <= 5600);

	const task = harness.registeredTools.get("plan_task");
	assert.deepEqual(Object.keys(task.parameters.properties), ["action", "sequence", "expectedAttached", "targetSequence", "title", "scope", "topic", "reason"]);
	assert.deepEqual(task.parameters.properties.action.enum, ["list", "pause", "resume", "update", "include", "discussion", "new", "abandon"]);
	assert.deepEqual(harness.registeredTools.get("plan_finish").parameters.properties.outcome.enum, ["awaiting_validation", "blocked", "waiting_for_input", "still_working"]);
	assert.deepEqual(harness.registeredTools.get("plan_step_control").parameters.properties.action.anyOf.map((item: any) => item.const), ["start", "complete", "skip", "revise", "pause", "resume", "cancel", "hide", "show"]);
});

test("an editor installed before Pi Plan Build triggers reduced optional UI", async () => {
	const otherEditor = () => undefined;
	const harness = createHarness(otherEditor);
	await start(harness);

	assert.deepEqual(harness.editorCalls, []);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]![0], /disabled its custom composer and experimental step-by-step panel/);
	assert.equal(harness.notifications[0]![1], "warning");
	assert.equal(harness.statuses.at(-1)?.[0], "pi-plan-build-mode");
	assert.match(harness.statuses.at(-1)?.[1] ?? "", /build/);

	await shutdown(harness);
	assert.deepEqual(harness.editorCalls, []);
});

test("a later decorator that invokes Pi Plan Build's editor retains full optional UI", async () => {
	const harness = createHarness();
	await start(harness);
	assert.equal(typeof harness.editorCalls[0], "function");

	harness.decorateCurrentEditor();
	await harness.handlers.get("before_agent_start")?.({}, harness.ctx);

	assert.equal(harness.notifications.length, 0);
	assert.equal(harness.statuses.at(-1)?.[1], undefined);
	await shutdown(harness);
	assert.equal(harness.editorCalls.includes(undefined), false);
});

test("a later editor owner is detected and is not cleared during teardown", async () => {
	const harness = createHarness();
	await start(harness);
	assert.equal(typeof harness.editorCalls[0], "function");

	const otherEditor = () => undefined;
	harness.setCurrentEditor(otherEditor);
	await harness.handlers.get("before_agent_start")?.({}, harness.ctx);

	assert.equal(harness.notifications.length, 1);
	assert.match(harness.statuses.at(-1)?.[1] ?? "", /build/);
	await shutdown(harness);
	assert.equal(harness.editorCalls.includes(undefined), false);
});
