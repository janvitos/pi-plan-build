import assert from "node:assert/strict";
import test from "node:test";
import planBuildModes from "./index.ts";

function createHarness(initialEditor?: unknown, startInPlan = false) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let currentEditor = initialEditor;
	const editorCalls: unknown[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const notifications: Array<[string, string]> = [];
	const shortcuts = new Map<string, unknown>();
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
		registerTool() {},
		registerCommand() {},
		registerShortcut(key: string, options: unknown) { shortcuts.set(key, options); },
		registerEntryRenderer() {},
		getFlag() { return startInPlan; },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(next: string[]) { activeTools = [...next]; },
		appendEntry() {},
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
				if (typeof factory === "function") factory(tui, editorTheme, keybindings);
			},
			setStatus(key: string, text: string | undefined) { statuses.push([key, text]); },
			notify(message: string, level: string) { notifications.push([message, level]); },
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
		getActiveTools() { return [...activeTools]; },
		setActiveTools(next: string[]) { activeTools = [...next]; },
		setCurrentEditor(value: unknown) { currentEditor = value; },
		decorateCurrentEditor() {
			const base = currentEditor as ((...args: any[]) => unknown) | undefined;
			assert.equal(typeof base, "function");
			ctx.ui.setEditorComponent((...args: any[]) => base!(...args));
		},
	};
}

async function start(harness: ReturnType<typeof createHarness>) {
	await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
}

async function shutdown(harness: ReturnType<typeof createHarness>) {
	await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
}

test("registers Alt+M without taking Pi's Shift+Tab thinking shortcut", () => {
	const harness = createHarness();
	assert.equal(harness.shortcuts.has("alt+m"), true);
	assert.equal(harness.shortcuts.has("ctrl+tab"), false);
	assert.equal(harness.shortcuts.has("shift+tab"), false);
});

test("restores Plan tools at turn end before an intra-run continuation", async () => {
	const harness = createHarness(undefined, true);
	await start(harness);
	await harness.handlers.get("before_agent_start")?.({}, harness.ctx);

	harness.setActiveTools(harness.getActiveTools().filter((name) => name !== "plan_exit"));
	assert.equal(harness.getActiveTools().includes("plan_exit"), false);

	await harness.handlers.get("turn_end")?.({}, harness.ctx);
	assert.equal(harness.getActiveTools().includes("plan_exit"), true);
	assert.equal(harness.getActiveTools().includes("plan_enter"), false);
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
