import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import planBuildModes from "./index.ts";
import { createPlanExecution } from "./plan-execution.ts";
import { decodePlanLifecycle, makePlanPath, PLAN_EXIT_APPROVE_CHOICE, PLAN_EXIT_FRESH_CHOICE, PLAN_EXIT_STAY_CHOICE, PLAN_ACTION_ANNOUNCEMENTS } from "./utils.ts";

function harness(dir: string, entries: any[] = [], sessionId = "session") {
	process.env.PI_CODING_AGENT_DIR = dir;
	const handlers = new Map<string, any[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entryRenderers = new Map<string, any>();
	const messageRenderers = new Map<string, any>();
	let active = ["read", "write", "edit", "bash"];
	let idle = true;
	const events: any[] = [];
	const pi = {
		getThinkingLevel: () => "medium",
		setThinkingLevel() {},
		setModel: async () => true,
		sendUserMessage: (text: string) => events.push({ kind: "dispatch", text }),
		sendMessage: (message: any, options: any) => events.push({ kind: "internal", message, options }),
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerShortcut() {}, registerFlag() {},
		registerEntryRenderer: (type: string, renderer: any) => entryRenderers.set(type, renderer),
		registerMessageRenderer: (type: string, renderer: any) => messageRenderers.set(type, renderer),
		getFlag: () => false,
		getActiveTools: () => active,
		setActiveTools: (next: string[]) => { events.push({ kind: "tools" }); active = next; },
		appendEntry: (customType: string, data: any) => {
			events.push({ kind: "entry", customType, data });
			const entry = { type: "custom", customType, data: structuredClone(data) };
			entries.push(entry);
			if (ctx.mode === "tui" && customType === "pi-plan-build-notice" && entryRenderers.has(customType)) {
				const component = entryRenderers.get(customType)(entry, { expanded: false }, ctx.ui.theme);
				events.push({ kind: "render", customType, text: component.render(120).join("\n").trim() });
			}
		},
	};
	const ctx = {
		mode: "rpc", hasUI: true, cwd: dir, isIdle: () => idle, hasPendingMessages: () => false,
		model: { provider: "test", id: "test" },
		modelRegistry: { find: () => ({ provider: "test", id: "test" }) },
		sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => sessionId, getSessionFile: () => undefined },
		ui: {
			getEditorComponent: () => undefined, setEditorComponent() {}, setStatus: (_key: string, text: string) => events.push({ kind: "status", text }),
			notify: (text: string) => events.push({ kind: "notify", text }),
			select: async () => PLAN_EXIT_APPROVE_CHOICE,
			theme: { fg: (_: string, text: string) => text, bold: (text: string) => text },
		},
	};
	planBuildModes(pi as any);
	async function emit(name: string, event: any = {}) {
		let result: any;
		const messages: any[] = [];
		for (const handler of handlers.get(name) ?? []) {
			const next = await handler(event, ctx);
			if (next !== undefined) result = next;
			if (name === "before_agent_start" && next?.message) messages.push(next.message);
		}
		return name === "before_agent_start" ? { ...result, messages } : result;
	}
	return {
		ctx, pi, events, commands, tools,
		entries, active: () => active, setIdle: (value: boolean) => { idle = value; },
		event: emit,
		prompt: async (text: string) => {
			await emit("input", { source: "interactive", text });
			const result = await emit("before_agent_start", { prompt: text });
			// Pi constructs this sequence before the agent loop emits/render its messages.
			const messages = [{ role: "user", content: text }, ...result.messages.map((message: any) => ({ role: "custom", ...message }))];
			for (const message of messages) {
				if (message.role === "user") {
					entries.push({ type: "message", message });
					events.push({ kind: "user", text });
				} else {
					entries.push({ type: "custom_message", ...message });
					if (ctx.mode === "tui" && message.display) {
						const component = messageRenderers.get(message.customType)(message, { expanded: false }, ctx.ui.theme);
						events.push({ kind: "render", customType: message.customType, text: component.render(120).join("\n").trim() });
					}
				}
			}
			const context = await emit("context", { messages });
			events.push({ kind: "assistant" });
			return context.messages;
		},
		command: (args: string) => commands.get("plan").handler(args, ctx),
		build: () => commands.get("build").handler("", ctx),
		tool: (name: string, args = {}) => tools.get(name).execute("id", args, undefined, undefined, ctx),
		state: () => entries.filter((entry) => entry.customType === "pi-plan-build-state").at(-1).data,
	};
}

test("planning tool renderers preserve errors and never report success for partial or missing results", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-visible-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		const entered = await h.tool("plan_enter");
		assert.equal(entered.content[0].text, "Switched to Plan mode.");
		const hidden = await h.event("context", { messages: [] });
		assert.match(hidden.messages.at(-1).content, /Plan mode is active/);
		const file = makePlanPath(path.join(dir, "plans"), "session", 1);
		fs.writeFileSync(file, "# Plan\n");
		const approved = await h.tool("plan_exit");
		assert.equal(approved.content[0].text, "Plan approved; switched to Build mode.");
		const buildContext = await h.event("context", { messages: [] });
		assert.match(buildContext.messages.at(-1).content, /Build mode permits/);
		const completed = await h.tool("plan_complete");
		assert.equal(completed.content[0].text, "Plan complete.");
		const samples: Record<string, any> = { plan_enter: entered, plan_exit: approved, plan_complete: completed };
		for (const name of ["plan_enter", "plan_exit", "plan_complete", "plan_finish", "plan_task", "plan_step_control", "plan_step_complete"]) {
			const tool = h.tools.get(name);
			for (const expanded of [false, true]) {
				const render = (result: any, isPartial: boolean, isError: boolean) => tool.renderResult(result, { expanded, isPartial }, h.ctx.ui.theme, { isError }).render(140).join("\n");
				assert.match(render({ content: [{ type: "text", text: "Actual failure" }] }, false, true), /Actual failure/, name);
				assert.match(render({ content: [{ type: "text", text: "Actual failure" }] }, true, true), /Actual failure/, name);
				const partial = render(samples[name] ?? { content: [{ type: "text", text: "Success sentinel" }], details: {} }, true, false);
				assert.doesNotMatch(partial, /Success sentinel|Switched to|Plan complete\.|Plan approved;/, name);
				const empty = render({ content: [], details: {} }, false, false);
				assert.doesNotMatch(empty, /Switched to|Plan complete\.|Remaining in Plan mode|cancelled/i, name);
				if (samples[name]) assert.doesNotMatch(render(samples[name], false, false), /system-reminder|Summarize the implementation|Stop now|execute the plan now/);
			}
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("completion reconciliation is one-shot and unfinished outcomes preserve the right state", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reconcile-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		const file = makePlanPath(path.join(dir, "plans"), "session", 1);
		const markdown = "# Work\n\n## Implementation Steps\n1. Work\n";
		fs.writeFileSync(file, markdown);
		const fixture = () => [{ type: "custom", customType: "pi-plan-build-state", data: { version: 1, selectedMode: "build", plan: { sequence: 1, status: "open", task: { title: "Work", scope: "Work", decisions: [] } } } }];
		const settle = async (h: ReturnType<typeof harness>, stopReason = "stop") => {
			await h.event("agent_end", { messages: [{ role: "assistant", stopReason, content: [{ type: "text", text: "Summary" }] }] });
			await h.event("agent_settled");
		};
		const mutation = (h: ReturnType<typeof harness>) => h.event("tool_result", { toolName: "edit", input: { path: path.join(dir, "project.ts") }, isError: false });
		const h = harness(dir, fixture());
		await h.event("session_start", { reason: "resume" });
		await h.prompt("Implement the plan");
		await mutation(h);
		await settle(h);
		assert.equal(h.events.filter((e) => e.kind === "internal").length, 1);
		const reminder = h.events.find((e) => e.kind === "internal");
		assert.equal(reminder.message.display, false);
		assert.equal(reminder.options.triggerTurn, true);
		assert.match(reminder.message.content, /not permission for more implementation/);
		assert.equal(h.state().reconciliation.consumed, true);
		await h.event("before_agent_start", { prompt: "" });
		await mutation(h);
		await settle(h);
		assert.equal(h.events.filter((e) => e.kind === "internal").length, 1);
		const restored = harness(dir, structuredClone(h.entries));
		await restored.event("session_start", { reason: "reload" });
		await settle(restored);
		assert.equal(restored.events.filter((e) => e.kind === "internal").length, 0, "reload never replays a reminder");
		await h.prompt("Continue implementing");
		await mutation(h);
		await settle(h);
		assert.equal(h.events.filter((e) => e.kind === "internal").length, 2, "new user work gets its own one-shot budget");
		await h.tool("plan_complete");
		assert.equal(h.state().collection.attached, null);
		for (const skip of ["conversation", "aborted", "error", "tool-error", "pending", "pause", "plan", "step", "complete", "blocked"]) {
			const f = fixture() as any[];
			if (skip === "step") f[0].data.execution = createPlanExecution(markdown);
			const check = harness(dir, f);
			await check.event("session_start", { reason: "resume" });
			await check.prompt("Work");
			if (skip !== "conversation") await mutation(check);
			if (skip === "pending") check.ctx.hasPendingMessages = () => true;
			if (skip === "tool-error") await check.event("tool_result", { toolName: "bash", input: {}, isError: true });
			if (skip === "pause") await check.tool("plan_task", { action: "pause", expectedAttached: 1 });
			if (skip === "plan") await check.command("");
			if (skip === "complete") await check.tool("plan_complete");
			if (skip === "blocked") await check.tool("plan_finish", { expectedAttached: 1, outcome: "blocked", reason: "Missing credential" });
			await settle(check, skip === "aborted" || skip === "error" ? skip : "stop");
			assert.equal(check.events.filter((e) => e.kind === "internal").length, 0, skip);
		}
		const pending = harness(dir, fixture());
		await pending.event("session_start", { reason: "resume" });
		await pending.prompt("Implement");
		await mutation(pending);
		await assert.rejects(pending.tool("plan_finish", { expectedAttached: 9, outcome: "blocked", reason: "Blocked" }), /Stale/);
		await assert.rejects(pending.tool("plan_finish", { expectedAttached: 1, outcome: "awaiting_validation", reason: "Hardware check" }), /userAction/);
		await pending.tool("plan_finish", { expectedAttached: 1, outcome: "awaiting_validation", reason: "Hardware needed", userAction: "Run the hardware acceptance check" });
		await settle(pending);
		assert.equal(pending.state().collection.attached, null);
		assert.equal(pending.state().collection.records[0].plan.status, "open");
		assert.equal(pending.state().collection.records[0].plan.outcome.userAction, "Run the hardware acceptance check");
		assert.equal(pending.events.filter((e) => e.kind === "internal").length, 0);
		assert.equal(fs.readFileSync(file, "utf8"), markdown);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("empty historical Build slots are detached but genuine plans and reservations survive", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-phantom-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const migrated of [false, true]) {
			const plan = { sequence: 1, status: "open" };
			const data = { version: 1, selectedMode: "build", plan, ...(migrated ? { collection: { records: [{ plan }], attached: 1, counter: 1 } } : {}) };
			const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data }]);
			await h.event("session_start", { reason: "resume" });
			assert.equal(h.state().collection.attached, null);
			assert.deepEqual(h.state().collection.records, []);
			assert.equal(h.state().collection.counter, 1);
			const context = await h.event("context", { messages: [] });
			assert.match(context.messages.at(-1).content, /no plan lookup or task initialization is required/i);
			assert.doesNotMatch(context.messages.at(-1).content, /session-001\.md/);
			await h.command("");
			assert.equal(h.state().collection.attached, 2);
			const planning = await h.event("context", { messages: [] });
			assert.match(planning.messages.at(-1).content, /Planning slot reserved/);
			assert.match(planning.messages.at(-1).content, /Do not read this absent file/);
		}
		for (const kind of ["metadata", "file", "execution", "reservation", "unavailable"] as const) {
			const id = kind;
			const file = makePlanPath(path.join(dir, "plans"), id, 1);
			if (kind === "file") fs.writeFileSync(file, "# Real saved plan\n");
			if (kind === "unavailable") fs.mkdirSync(file);
			const plan = { sequence: 1, status: "open", ...(kind === "metadata" ? { task: { title: "Unsaved planning", scope: "Legitimate scope", decisions: [] } } : {}) };
			const data = { version: 1, selectedMode: kind === "reservation" ? "plan" : "build", plan, ...(kind === "execution" ? { execution: createPlanExecution("# Work\n\n## Implementation Steps\n1. Work\n") } : {}) };
			const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data }], id);
			await h.event("session_start", { reason: "resume" });
			assert.equal(h.state().collection.attached, 1, kind);
			const context = await h.event("context", { messages: [] });
			assert.match(context.messages.at(-1).content, kind === "file" || kind === "execution" ? /Saved plan file/ : kind === "unavailable" ? /Plan file unavailable/ : /Do not read this absent file/);
			if (kind === "file") assert.equal(fs.readFileSync(file, "utf8"), "# Real saved plan\n");
		}
		// A fork must check the source before treating its not-yet-copied destination as empty.
		const source = makePlanPath(path.join(dir, "plans"), "source", 1);
		fs.writeFileSync(source, "# Source plan\n");
		const fork = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data: { version: 1, selectedMode: "build", planSessionId: "source", plan: { sequence: 1, status: "open" } } }], "child");
		await fork.event("session_start", { reason: "fork" });
		assert.equal(fork.state().collection.attached, 1);
		assert.equal(fs.readFileSync(makePlanPath(path.join(dir, "plans"), "child", 1), "utf8"), "# Source plan\n");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("task results are compact while hidden context retains current planning constraints", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-output-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		await h.command("");
		const renderer = h.tools.get("plan_task");
		const result = await h.tool("plan_task", { action: "update", sequence: 1, title: "Fix login", scope: "Login redirects" });
		assert.equal(result.content[0].text, "Plan title/scope updated: Fix login");
		assert.equal(result.details.fileState, "absent");
		const count = h.entries.length;
		const unchanged = await h.tool("plan_task", { action: "update", sequence: 1, title: "Fix login", scope: "Login redirects" });
		assert.match(unchanged.content[0].text, /Plan unchanged/);
		assert.equal(h.entries.length, count);
		const rendered = renderer.renderResult(result, { expanded: false, isPartial: false }, h.ctx.ui.theme, {}).render(120).join("\n");
		assert.match(rendered, /Fix login/);
		assert.doesNotMatch(rendered, /Plan mode is active|system-reminder|Task metadata/);
		const expanded = renderer.renderResult(result, { expanded: true, isPartial: false }, h.ctx.ui.theme, {}).render(120).join("\n");
		assert.match(expanded, /Attachment: 1/);
		assert.match(expanded, /absent/);
		assert.doesNotThrow(() => renderer.renderCall({}, h.ctx.ui.theme).render(80));
		const partial = renderer.renderResult(result, { expanded: false, isPartial: true }, h.ctx.ui.theme, {}).render(80).join("\n");
		assert.doesNotMatch(partial, /updated:/);
		const error = renderer.renderResult({ content: [{ type: "text", text: "Stale attachment" }] }, { expanded: true, isPartial: false }, h.ctx.ui.theme, { isError: true }).render(80).join("\n");
		assert.match(error, /Stale attachment/);
		const context = await h.event("context", { messages: [] });
		assert.match(context.messages.at(-1).content, /Plan mode is active/);
		assert.match(context.messages.at(-1).content, /Do not read this absent file/);
		await h.build();
		const paused = await h.tool("plan_task", { action: "pause", expectedAttached: 1 });
		assert.equal(paused.content[0].text, "Plan paused: Fix login");
		const list = await h.tool("plan_task", { action: "list" });
		assert.match(list.content[0].text, /1: Fix login \[paused; absent\]/);
		assert.doesNotMatch(list.content[0].text, /Build mode permits/);
		const resumed = await h.tool("plan_task", { action: "resume", expectedAttached: null, targetSequence: 1 });
		assert.equal(resumed.content[0].text, "Plan resumed: Fix login");
		const buildContext = await h.event("context", { messages: [] });
		assert.match(buildContext.messages.at(-1).content, /Build mode permits/);
		assert.match(buildContext.messages.at(-1).content, /Active task sequence \(internal\): 1/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("multiple plans detach, resume, fork, and complete without losing paused progress", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-attachment-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		const fileA = makePlanPath(path.join(dir, "plans"), "session", 1);
		const markdown = "# Login\n\n## Implementation Steps\n1. Fix login\n";
		fs.writeFileSync(fileA, markdown);
		const progress = createPlanExecution(markdown);
		progress.steps[0].status = "active";
		const entries = [{ type: "custom", customType: "pi-plan-build-state", data: { version: 1, selectedMode: "build", planSessionId: "session", plan: { sequence: 1, status: "open", task: { title: "Login", scope: "Login redirects", decisions: [] } }, execution: progress } }];
		const h = harness(dir, entries);
		h.ctx.ui.getEditorComponent = () => (() => {}) as any;
		await h.event("session_start", { reason: "resume" });
		assert.equal(h.state().collection.attached, 1);
		await h.tool("plan_task", { action: "include", expectedAttached: 1, topic: "Logout", scope: "Login and logout redirects" });
		const attachedBranch = structuredClone(h.entries);
		h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "plan_task", arguments: { action: "pause" } }] } });
		for (const toolName of ["write", "bash", "plan_step_complete"]) assert.equal((await h.event("tool_call", { toolName, input: { path: path.join(dir, "unrelated.ts") } })).block, true);
		await h.tool("plan_task", { action: "pause", expectedAttached: 1 });
		assert.equal(h.state().collection.attached, null);
		assert.equal(h.state().execution, undefined);
		assert.equal(h.events.filter((e) => e.kind === "status").at(-1).text, "build");
		assert.ok(!h.active().includes("plan_step_complete"));
		assert.ok(!h.active().includes("plan_step_control"));
		h.entries.push({ type: "message", message: { role: "assistant", content: [] } });
		assert.equal(await h.event("tool_call", { toolName: "write", input: { path: path.join(dir, "unrelated.ts") } }), undefined);
		assert.equal((await h.event("tool_call", { toolName: "write", input: { path: fileA } })).block, true);
		await assert.rejects(h.tool("plan_complete"), /No attached/);
		await assert.rejects(h.tool("plan_step_complete", { summary: "unrelated fix" }), /No plan step/);
		const detached = await h.event("context", { messages: [] });
		assert.match(detached.messages.at(-1).content, /No plan is attached/);
		await assert.rejects(h.tool("plan_task", { action: "resume", expectedAttached: 1, targetSequence: 1 }), /Stale/);
		await assert.rejects(h.tool("plan_task", { action: "resume", expectedAttached: null }), /targetSequence/);
		await h.command("");
		assert.equal(h.state().collection.attached, 2, "Plan entry never silently resumes A");
		await h.tool("plan_task", { action: "update", sequence: 2, title: "Billing", scope: "Export invoices" });
		const fileB = makePlanPath(path.join(dir, "plans"), "session", 2);
		fs.writeFileSync(fileB, "# Billing\n");
		await h.build();
		await h.tool("plan_task", { action: "resume", expectedAttached: 2, targetSequence: 1 });
		assert.deepEqual(h.state().execution, progress);
		assert.equal(h.state().collection.records.find((r: any) => r.plan.sequence === 2).plan.status, "open");
		await h.command("pause");
		const beforeCancel = structuredClone(h.state().collection);
		h.ctx.ui.select = async () => undefined as any;
		await h.command("resume");
		assert.deepEqual(h.state().collection, beforeCancel, "cancelled ambiguous selection changes nothing");
		await h.command("resume 1");
		const restored = harness(dir, structuredClone(h.entries));
		await restored.event("session_start", { reason: "reload" });
		assert.equal(restored.state().collection.attached, 1);
		assert.equal(restored.state().plan.task.scope, "Login and logout redirects");
		assert.deepEqual(restored.state().execution, progress);
		const fork = harness(dir, structuredClone(restored.entries), "fork");
		await fork.event("session_start", { reason: "fork" });
		assert.equal(fs.readFileSync(makePlanPath(path.join(dir, "plans"), "fork", 1), "utf8"), markdown);
		assert.equal(fs.readFileSync(makePlanPath(path.join(dir, "plans"), "fork", 2), "utf8"), "# Billing\n");
		await restored.tool("plan_step_complete", { summary: "Login verified" });
		assert.equal(restored.state().collection.attached, null);
		assert.equal(restored.state().collection.records.find((r: any) => r.plan.sequence === 1).plan.status, "completed");
		assert.equal(restored.state().collection.records.find((r: any) => r.plan.sequence === 2).plan.status, "open");
		await restored.tool("plan_task", { action: "resume", expectedAttached: null, targetSequence: 2 });
		assert.equal(restored.state().plan.task.title, "Billing");
		assert.equal(fs.readFileSync(fileA, "utf8"), markdown);
		assert.equal(fs.readFileSync(fileB, "utf8"), "# Billing\n");
		// Navigating to a prior branch restores that branch's attachment and progress.
		const historical = harness(dir, attachedBranch);
		await historical.event("session_start", { reason: "resume" });
		await historical.tool("plan_task", { action: "pause", expectedAttached: 1 });
		historical.entries.pop();
		await historical.event("session_tree");
		const historyContext = await historical.event("context", { messages: [] });
		assert.match(historyContext.messages.at(-1).content, /Active task sequence \(internal\): 1/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("titles follow unfinished plans across modes, saved-file refreshes, and completion", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-title-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		h.ctx.ui.getEditorComponent = () => (() => {}) as any;
		const status = () => h.events.filter((e) => e.kind === "status").at(-1)?.text;
		await h.event("session_start", { reason: "startup" });
		assert.equal(status(), "build", "ordinary Build session has no task label");
		assert.equal(h.state().collection.attached, null);
		assert.deepEqual(h.state().collection.records, []);
		await h.command("");
		assert.equal(status(), "plan", "an empty Plan slot has no task label");
		const file = makePlanPath(path.join(dir, "plans"), "session", 1);
		fs.writeFileSync(file, "# Saved heading\n");
		await h.event("tool_result", { toolName: "write", input: { path: file }, isError: false });
		assert.equal(status(), "Saved heading");
		await h.build();
		assert.equal(status(), "Saved heading");
		await h.event("session_start", { reason: "reload" });
		assert.equal(status(), "Saved heading");
		assert.equal(fs.readFileSync(file, "utf8"), "# Saved heading\n");
		fs.writeFileSync(file, "No heading\n");
		await h.event("tool_result", { toolName: "edit", input: { path: file }, isError: false });
		assert.equal(status(), "Untitled task");
		await h.command("");
		await h.tool("plan_task", { action: "update", sequence: 1, title: "Fix redirects", scope: "Fix login" });
		await h.build();
		assert.equal(status(), "Fix redirects");
		await h.command("");
		assert.equal(status(), "Fix redirects");
		fs.writeFileSync(file, "# Different heading\n");
		await h.event("tool_result", { toolName: "write", input: { path: file }, isError: false });
		assert.equal(status(), "Fix redirects", "metadata takes precedence");
		await h.build();
		await h.tool("plan_complete");
		assert.equal(status(), "build", "completion refreshes status immediately");
		await h.command("");
		assert.equal(status(), "plan", "re-entering Plan after completion has no task label");
		await h.event("session_start", { reason: "reload" });
		assert.equal(status(), "plan", "an empty reserved slot remains untitled without a placeholder after reload");
		await h.tool("plan_task", { action: "update", sequence: 2, title: "Export billing", scope: "Export invoices" });
		await h.build();
		assert.equal(status(), "Export billing");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("task identity and decisions survive restore while separate tasks preserve saved files", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-task-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		await h.command("");
		assert.ok(h.active().includes("plan_task"));
		await h.tool("plan_task", { action: "update", sequence: 1, title: "Fix login redirects", scope: "Fix redirects" });
		const first = makePlanPath(path.join(dir, "plans"), "session", 1);
		assert.equal(fs.existsSync(first), false);
		fs.writeFileSync(first, "# Login plan\n");
		await h.tool("plan_task", { action: "include", sequence: 1, topic: "Logout", scope: "Fix redirects and logout" });
		await h.tool("plan_task", { action: "discussion", sequence: 1, topic: "Billing", scope: "must not replace scope" });
		await h.tool("plan_task", { action: "discussion", sequence: 1, topic: "billing" });
		assert.equal(h.state().plan.task.decisions.length, 2);
		assert.equal(h.state().plan.task.scope, "Fix redirects and logout");
		h.state().collection.records[0].execution = createPlanExecution("# Login\n\n## Implementation Steps\n1. Fix login\n");
		const restored = harness(dir, h.entries);
		await restored.event("session_start", { reason: "resume" });
		assert.ok(restored.state().execution);
		const context = await restored.event("context", { messages: [] });
		assert.match(context.messages.at(-1).content, /Fix login redirects/);
		assert.match(context.messages.at(-1).content, /discussion/);
		assert.match(context.messages.at(-1).content, /billing/);
		// Trigger reduced UI to exercise the title-only status fallback.
		restored.ctx.ui.getEditorComponent = () => (() => {}) as any;
		await restored.prompt("Continue discussing");
		assert.ok(restored.events.some((e) => e.kind === "status" && e.text === "Fix login redirects"));
		await assert.rejects(restored.tool("plan_task", { action: "new", sequence: 0, title: "Wrong", scope: "Wrong" }), /Stale/);
		await assert.rejects(restored.tool("plan_task", { action: "new", sequence: 1 }), /title and scope/);
		restored.ctx.ui.select = async () => PLAN_EXIT_FRESH_CHOICE;
		await restored.tool("plan_exit");
		restored.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "plan_task" }, { type: "toolCall", name: "write" }] } });
		assert.equal((await restored.event("tool_call", { toolName: "write", input: { path: first } })).block, true);
		const result = await restored.tool("plan_task", { action: "new", sequence: 1, title: "Billing exports", scope: "Export invoices" });
		const second = makePlanPath(path.join(dir, "plans"), "session", 2);
		assert.equal(result.details.planPath, second);
		assert.match(result.content[0].text, /Billing exports/);
		assert.equal(fs.readFileSync(first, "utf8"), "# Login plan\n");
		assert.equal(fs.existsSync(second), false);
		assert.deepEqual(restored.state().plan.task.decisions, []);
		assert.equal(restored.state().plan.status, "open");
		assert.equal(restored.state().execution, undefined);
		await restored.commands.get("build-fresh").handler("", restored.ctx);
		assert.ok(restored.events.some((e) => e.kind === "notify" && e.text.startsWith("No fresh implementation is pending")));
		restored.entries.push({ type: "message", message: { role: "assistant", content: [] } });
		assert.equal((await restored.event("tool_call", { toolName: "write", input: { path: first } })).block, true);
		assert.equal(await restored.event("tool_call", { toolName: "write", input: { path: second } }), undefined);
		await restored.build();
		assert.ok(restored.active().includes("plan_task"));
		await restored.tool("plan_task", { action: "update", sequence: 2, title: "Billing title in Build" });
		await assert.rejects(restored.tool("plan_task", { action: "new", sequence: 2 }), /Plan mode/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("plan lifecycle keeps revisions, preserves completed plans, and restores the active task", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		await h.command("");
		const first = makePlanPath(path.join(dir, "plans"), "session", 1);
		assert.equal(fs.existsSync(first), false, "discussion does not create a file");
		fs.writeFileSync(first, "# First task\n");
		await h.build();
		await h.command("");
		assert.equal(h.state().plan.sequence, 1, "mode toggles resume unfinished work");
		await h.tool("plan_exit");
		assert.equal(h.state().plan.status, "open", "approval is not completion");
		for (const [toolName, input] of [
			["edit", { path: first, edits: [{ oldText: "# First task", newText: "# Changed task" }] }],
			["write", { path: first, content: "# Replaced task\n" }],
		] as const) {
			const blocked = await h.event("tool_call", { toolName, input });
			assert.equal(blocked.block, true, `${toolName} cannot mutate the active plan in Build mode`);
			assert.match(blocked.reason, /plan_complete/);
		}
		assert.equal(fs.readFileSync(first, "utf8"), "# First task\n");
		await h.event("agent_settled");
		assert.equal(h.state().plan.status, "open", "settling is not completion");
		await h.tool("plan_complete");
		assert.equal(h.active().includes("plan_complete"), false);
		assert.equal(fs.readFileSync(first, "utf8"), "# First task\n", "completion preserves the approved plan");
		await h.command("");
		assert.equal(h.state().plan.sequence, 2);
		assert.equal(fs.readFileSync(first, "utf8"), "# First task\n");
		await h.event("before_agent_start");
		assert.equal((await h.event("tool_call", { toolName: "write", input: { path: first } })).block, true);
		const second = makePlanPath(path.join(dir, "plans"), "session", 2);
		assert.equal(await h.event("tool_call", { toolName: "write", input: { path: second } }), undefined);
		fs.writeFileSync(second, "# Second task\n");
		await h.event("session_shutdown");
		const restored = harness(dir, h.entries);
		await restored.event("session_start", { reason: "resume" });
		assert.equal(restored.state().plan.sequence, 2);
		restored.setIdle(false);
		await restored.command("new");
		assert.equal(restored.state().plan.sequence, 2, "busy runs cannot change plan identity");
		restored.setIdle(true);
		await restored.command("new");
		assert.equal(restored.state().plan.sequence, 3);
		assert.equal(fs.readFileSync(second, "utf8"), "# Second task\n");
		await restored.build();
		await restored.command("done");
		assert.equal(restored.state().plan.status, "open", "cannot complete an unwritten plan");
		await restored.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy plan migration and fork copies preserve the source file", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-legacy-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		const legacy = makePlanPath(path.join(dir, "plans"), "session");
		fs.writeFileSync(legacy, "legacy plan");
		const h = harness(dir);
		await h.event("session_start", { reason: "resume" });
		assert.equal(h.state().plan.sequence, 0);
		await h.event("session_shutdown");
		const fork = harness(dir, structuredClone(h.entries), "child");
		await fork.event("session_start", { reason: "fork" });
		assert.equal(fs.readFileSync(makePlanPath(path.join(dir, "plans"), "child"), "utf8"), "legacy plan");
		await fork.command("done");
		assert.equal(fork.state().plan.status, "completed");
		await fork.command("");
		assert.equal(fork.state().plan.sequence, 1);
		assert.equal(fs.readFileSync(legacy, "utf8"), "legacy plan");
		await fork.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("final step completion rotates the plan, while cancellation keeps it unfinished", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-steps-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		const markdown = "# Task\n\n## Implementation Steps\n1. Implement task\n";
		fs.writeFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), markdown);
		const entries = [{ type: "custom", customType: "pi-plan-build-state", data: {
			version: 1, selectedMode: "build", plan: { sequence: 1, status: "open" },
			execution: createPlanExecution(markdown),
		} }];
		const h = harness(dir, structuredClone(entries));
		await h.event("session_start", { reason: "resume" });
		await h.tool("plan_step_control", { action: "complete" });
		assert.equal(h.state().plan.status, "completed");
		assert.equal(h.state().execution, undefined);
		assert.equal(fs.readFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), "utf8"), markdown, "step completion leaves the numbered plan unchanged");
		await h.command("");
		assert.equal(h.state().plan.sequence, 2);
		await h.event("session_shutdown");
		const cancelled = harness(dir, structuredClone(entries));
		await cancelled.event("session_start", { reason: "resume" });
		await cancelled.tool("plan_step_control", { action: "cancel" });
		assert.equal(cancelled.state().plan.status, "open");
		await cancelled.command("");
		assert.equal(cancelled.state().plan.sequence, 1);
		await cancelled.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("plan selections announce before proceeding, with fresh feedback in the destination", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-announcement-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const mode of ["tui", "rpc"]) {
			for (const choice of [PLAN_EXIT_APPROVE_CHOICE, PLAN_EXIT_STAY_CHOICE, undefined, PLAN_EXIT_FRESH_CHOICE]) {
				// Each case starts a fresh session; do not reuse prior cases' numbered plan files.
				fs.rmSync(path.join(dir, "plans"), { recursive: true, force: true });
				const h = harness(dir);
				await h.event("session_start", { reason: "startup" });
				assert.equal(h.events.some(e => e.customType === "pi-plan-build-notice"), false, "ordinary startup does not announce fresh implementation");
				await h.command("");
				await h.tool("plan_task", { action: "update", sequence: 1, title: "Approved task title", scope: "Implement approved plan" });
				h.ctx.mode = mode;
				h.ctx.ui.select = async () => choice as any;
				fs.writeFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), "# Approved plan\n");
				if (choice === PLAN_EXIT_FRESH_CHOICE) {
					await h.tool("plan_task", { action: "new", sequence: 1, title: "Paused work", scope: "Other work" });
					await h.tool("plan_task", { action: "resume", expectedAttached: h.state().collection.attached, targetSequence: 1 });
				}
				h.events.length = 0;
				const result = await h.tool("plan_exit");
				const notices = h.events.filter(e => e.kind === "entry" && e.customType === "pi-plan-build-notice");
				if (choice === PLAN_EXIT_FRESH_CHOICE) {
					assert.equal(notices.length, 0, "fresh announcement must not be stranded in the source");
					assert.equal(result.terminate, true);
					const child = harness(dir, [], "destination");
					child.ctx.mode = mode;
					const destination = child.events;
					(h.ctx as any).newSession = async ({ setup, withSession }: any) => {
						await setup({
							getSessionId: () => "destination",
							appendModelChange() {}, appendThinkingLevelChange() {},
							// Raw storage does not emit the live entry event.
							appendCustomEntry: (customType: string, data: any) => child.entries.push({ type: "custom", customType, data }),
						});
						assert.equal(child.state().pendingFreshAnnouncement, true);
						assert.equal(child.state().plan.task.title, "Approved task title");
						assert.equal(destination.length, 0);
						await h.event("session_shutdown");
						await child.event("session_start", { reason: "new" });
						assert.equal(child.state().pendingFreshAnnouncement, true);
						assert.equal(child.state().collection.records.length, 1);
						assert.ok(h.state().collection.records.some((r: any) => r.plan.task?.title === "Paused work"));
						assert.equal(destination.some(e => e.kind === "render" || e.text === PLAN_ACTION_ANNOUNCEMENTS["implement-fresh"]), false);
						await withSession({
							...child.ctx,
							ui: { ...child.ctx.ui, setEditorText() {} },
							sendUserMessage: async (text: string) => {
								const context = await child.prompt(text);
								assert.ok(context.some((message: any) => message.role === "user" && message.content === text));
								assert.ok(context.some((message: any) => message.customType === "pi-plan-build-reminder"));
								assert.equal(context.some((message: any) => message.customType === "pi-plan-build-fresh-announcement"), false);
							},
						});
						return { cancelled: false };
					};
					await h.commands.get("build-fresh").handler("", h.ctx);
					const noticeType = "pi-plan-build-fresh-announcement";
					const user = destination.findIndex(e => e.kind === "user");
					const assistant = destination.findIndex(e => e.kind === "assistant");
					assert.ok(user >= 0 && assistant > user);
					assert.ok(destination[user].text.includes("# Approved plan"));
					const storedNotice = child.entries.findIndex(e => e.customType === noticeType);
					assert.ok(storedNotice > child.entries.findIndex(e => e.message?.role === "user"));
					assert.equal(child.entries[storedNotice].content, PLAN_ACTION_ANNOUNCEMENTS["implement-fresh"]);
					assert.equal(child.entries.filter(e => e.customType === noticeType).length, 1);
					assert.equal(child.entries.some(e => e.customType === "pi-plan-build-notice"), false);
					assert.equal(child.state().pendingFreshAnnouncement, undefined);
					const renders = destination.filter(e => e.kind === "render" && e.customType === noticeType);
					assert.equal(renders.length, mode === "tui" ? 1 : 0);
					if (mode === "tui") {
						assert.equal(renders[0].text, "I’ll implement the approved plan in this clean session.");
						assert.ok(user < destination.indexOf(renders[0]) && destination.indexOf(renders[0]) < assistant);
					}
					const rpcNotices = destination.filter(e => e.kind === "notify" && e.text === PLAN_ACTION_ANNOUNCEMENTS["implement-fresh"]);
					assert.equal(rpcNotices.length, mode === "rpc" ? 1 : 0);
					if (mode === "rpc") assert.ok(destination.indexOf(rpcNotices[0]) < assistant);
					await child.prompt("A subsequent prompt");
					assert.equal(child.entries.filter(e => e.customType === noticeType).length, 1);
					await child.event("session_shutdown");
					const restored = harness(dir, child.entries, "destination");
					restored.ctx.mode = mode;
					await restored.event("session_start", { reason: "reload" });
					await restored.prompt("After reload");
					assert.equal(restored.events.some(e => e.customType === noticeType || e.text === PLAN_ACTION_ANNOUNCEMENTS["implement-fresh"]), false);
					assert.equal(restored.entries.filter(e => e.customType === noticeType).length, 1);
					await restored.event("session_shutdown");
				} else {
					assert.equal(notices.length, 1);
					const action = choice === PLAN_EXIT_APPROVE_CHOICE ? "implement-here" : "stay";
					assert.equal(notices[0].data.message, PLAN_ACTION_ANNOUNCEMENTS[action]);
					assert.equal(h.events.filter(e => e.kind === "notify" && e.text === notices[0].data.message).length, mode === "rpc" ? 1 : 0);
					if (action === "implement-here") {
						assert.ok(h.events.indexOf(notices[0]) < h.events.findIndex(e => e.kind === "tools"));
					} else {
						assert.equal(result.terminate, true);
						assert.equal(h.state().selectedMode, "plan");
						assert.equal(h.events.some(e => e.kind === "dispatch"), false);
					}
				}
				await h.event("session_shutdown");
			}
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("fresh acknowledgement survives reload before kickoff and filters only its own context message", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-fresh-pending-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data: {
			version: 1, selectedMode: "build", pendingFreshAnnouncement: true,
		} }]);
		await h.event("session_start", { reason: "new" });
		assert.equal(h.state().pendingFreshAnnouncement, true);
		await h.event("session_shutdown");
		const restored = harness(dir, h.entries);
		await restored.event("session_start", { reason: "reload" });
		assert.equal(restored.state().pendingFreshAnnouncement, true);
		assert.equal(restored.events.some(e => e.text === PLAN_ACTION_ANNOUNCEMENTS["implement-fresh"]), false);
		await restored.prompt("Read the approved plan");
		assert.equal(restored.state().pendingFreshAnnouncement, undefined);
		assert.equal(restored.entries.filter(e => e.customType === "pi-plan-build-fresh-announcement").length, 1);
		const keep = [
			{ role: "user", content: "Approved plan" },
			{ role: "custom", customType: "pi-plan-build-reminder", content: "Build reminder" },
			{ role: "custom", customType: "another-extension", content: "Other context" },
		];
		const context = await restored.event("context", { messages: [
			...keep, { role: "custom", customType: "pi-plan-build-fresh-announcement", content: "UI only" },
		] });
		assert.deepEqual(context.messages.filter((message: any) => message.customType !== "pi-plan-build-task"), keep);
		assert.match(context.messages.at(-1).content, /Build mode permits free discussion/);
		await restored.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("failed fresh-session setup does not announce success or start implementation", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-fresh-failure-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		await h.command("");
		fs.writeFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), "# Approved plan\n");
		h.ctx.ui.select = async () => PLAN_EXIT_FRESH_CHOICE;
		await h.tool("plan_exit");
		const child = harness(dir, [], "failed-destination");
		(h.ctx as any).newSession = async ({ setup, withSession }: any) => {
			await setup({
				getSessionId: () => "failed-destination",
				appendModelChange() { throw new Error("setup failure"); },
				appendCustomEntry: (customType: string, data: any) => child.entries.push({ type: "custom", customType, data }),
			});
			await h.event("session_shutdown");
			await child.event("session_start", { reason: "new" });
			await withSession({
				...child.ctx,
				ui: { ...child.ctx.ui, setEditorText: (text: string) => child.events.push({ kind: "editor", text }) },
				sendUserMessage: async () => child.events.push({ kickoff: true }),
			});
			return { cancelled: false };
		};
		await h.commands.get("build-fresh").handler("", h.ctx);
		assert.equal(child.events.some(e => e.kickoff || e.customType === "pi-plan-build-notice" || e.customType === "pi-plan-build-fresh-announcement" || e.text === PLAN_ACTION_ANNOUNCEMENTS["implement-fresh"]), false);
		assert.equal(child.events.some(e => e.kind === "notify" && e.text.includes("setup failed: setup failure")), true);
		assert.equal(child.events.some(e => e.kind === "editor" && e.text.includes("# Approved plan")), true);
		assert.equal(child.state().pendingFreshAnnouncement, undefined);
		await child.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("lifecycle decoding and sequence paths reject invalid state", () => {
	assert.deepEqual(decodePlanLifecycle({ sequence: 2, status: "completed" }), { sequence: 2, status: "completed" });
	for (const sequence of [-1, NaN, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
		assert.equal(decodePlanLifecycle({ sequence, status: "open" }), undefined);
	}
	assert.equal(decodePlanLifecycle({ sequence: 1, status: "unknown" }), undefined);
	assert.throws(() => makePlanPath("/tmp", "session", -1));
	assert.equal(makePlanPath("/tmp", "session", 12), "/tmp/session-012.md");
});
