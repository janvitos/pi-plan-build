import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { CombinedAutocompleteProvider, matchesKey } from "@earendil-works/pi-tui";
import planBuildModes from "./index.ts";
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

function createHarness(initialEditor?: unknown) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
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
	let resolvePersist: (() => void) | undefined;
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
	const keybindings = { matches: () => false };
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			handlers.set(name, handler);
		},
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
			resolvePersist?.();
			resolvePersist = undefined;
		},
		getThinkingLevel() { return "medium"; },
	};
	const ctx = {
		mode: "tui",
		cwd: "/tmp/project",
		hasUI: true,
		isIdle: () => true,
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "ui-compat-test",
		},
		ui: {
			getEditorComponent: () => currentEditor,
			setEditorComponent(factory: unknown) {
				editorCalls.push(factory);
				currentEditor = factory;
				if (typeof factory === "function") {
					createdEditor = factory(tui, editorTheme, keybindings);
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
				return selectedOption;
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
		nextPersist: () => new Promise<void>((resolve) => { resolvePersist = resolve; }),
		editor: () => createdEditor,
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
	const persisted = harness.nextPersist();
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
	assert.equal(harness.persisted.at(-1).selectedMode, "build");
}

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

test("settings save the selected preset, retain active bindings until reload, and reload correctly", async () => {
	const harness = createHarness();
	await start(harness);
	harness.selectOption("Alt+M only");
	await harness.commands.get("plan-settings").handler("", harness.ctx);
	assert.match(harness.selections[0]!.title, /active: Tab \+ Alt\+M/);
	assert.deepEqual(harness.selections[0]!.options, ["Tab + Alt+M", "Alt+M only", "Disabled", "Custom (edit config file)"]);
	assert.match(harness.notifications.at(-1)![0], /Saved Alt\+M only.*\/reload/);
	assert.equal(harness.editor().matchesModeToggle("\t"), true);
	await shutdown(harness);

	const reloaded = createHarness();
	await start(reloaded);
	await completeFile(reloaded);
	reloaded.selectOption("Disabled");
	await reloaded.commands.get("plan-settings").handler("", reloaded.ctx);
	assert.match(reloaded.selections[0]!.title, /active: Alt\+M only/);
	assert.deepEqual(loadShortcutConfig(agentDir).config, { toggleMode: [], toggleModeInEditor: [] });
});

test("settings cancellation and custom guidance do not create or overwrite configuration", async () => {
	const harness = createHarness();
	const command = harness.commands.get("plan-settings");
	await command.handler("", harness.ctx);
	assert.equal(fs.existsSync(path.join(agentDir, SHORTCUT_CONFIG_FILE)), false);
	writeConfig({ shortcuts: { toggleMode: "f6", toggleModeInEditor: [] }, unrelated: true });
	const before = fs.readFileSync(path.join(agentDir, SHORTCUT_CONFIG_FILE), "utf8");
	harness.selectOption("Custom (edit config file)");
	await command.handler("", harness.ctx);
	assert.ok(harness.notifications.at(-1)![0].includes(path.join(agentDir, SHORTCUT_CONFIG_FILE)));
	assert.match(harness.notifications.at(-1)![0], /toggleModeInEditor.*file completion/);
	assert.equal(fs.readFileSync(path.join(agentDir, SHORTCUT_CONFIG_FILE), "utf8"), before);
});

test("settings report a failed save without overwriting malformed JSON", async () => {
	const configPath = path.join(agentDir, SHORTCUT_CONFIG_FILE);
	fs.writeFileSync(configPath, "{");
	const harness = createHarness();
	harness.selectOption("Alt+M only");
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
		"Call plan_exit after finalizing the saved plan when the user asks to show, review, or approve it.",
	]);
});

test("an editor installed before Pi Plan Build triggers reduced optional UI", async () => {
	const otherEditor = () => undefined;
	const harness = createHarness(otherEditor);
	await start(harness);

	assert.deepEqual(harness.editorCalls, []);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]![0], /disabled its custom composer and experimental step-by-step panel/);
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
