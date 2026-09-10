import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { convertToLlm, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { eventHandlers } from "./test-events.ts";
import { STATE_VERSION, restoreCollection, allocationHighWater } from "./plan-state.ts";
import planBuildModes from "./index.ts";
import { createPlanExecution } from "./plan-execution.ts";
import { decodePlanLifecycle, makePlanPath, PLAN_EXIT_APPROVE_CHOICE, PLAN_EXIT_FRESH_CHOICE, PLAN_EXIT_STAY_CHOICE, PLAN_ACTION_ANNOUNCEMENTS } from "./utils.ts";

function harness(dir: string, entries: any[] = [], sessionId = "session") {
	process.env.PI_CODING_AGENT_DIR = dir;
	const { handlers, on } = eventHandlers();
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
		on,
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
			confirm: async () => true,
			select: async () => PLAN_EXIT_APPROVE_CHOICE,
			theme: { fg: (_: string, text: string) => text, bold: (text: string) => text },
		},
	};
	planBuildModes(pi as any);
	async function emit(name: string, event: any = {}) {
		return handlers.get(name)?.(event, ctx);
	}
	function state() {
		const raw = entries.filter((entry) => entry.customType === "pi-plan-build-state").at(-1)?.data;
		return raw ?? { version: 3, selectedMode: "build", collection: { records: [], attached: null, counter: 0 } };
	}
	function record() {
		const collection = state().collection;
		return collection?.records.find((r: any) => r.plan.sequence === collection.attached) ?? collection?.records.at(-1);
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
			const accumulated = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : entry.type === "custom_message" ? [{ role: "custom", ...entry }] : []);
			const context = await emit("context", { messages: accumulated });
			events.push({ kind: "assistant" });
			return context.messages;
		},
		command: (args: string) => commands.get("plan").handler(args, ctx),
		build: () => commands.get("build").handler("", ctx),
		tool: (name: string, args = {}) => tools.get(name).execute("id", args, undefined, undefined, ctx),
		state, record,
		callTool: async (name: string, args = {}) => {
			assert.ok(active.includes(name), `${name} must be active at schema selection`);
			const tool = tools.get(name);
			assert.ok(Check(tool.parameters, args), `${name} arguments must match the public schema`);
			entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name, arguments: args }] } });
			await emit("tool_execution_start", { toolName: name, toolCallId: "call", args });
			const block = await emit("tool_call", { toolName: name, toolCallId: "call", input: args });
			if (block?.block) throw new Error(block.reason);
			const result = await tool.execute("call", args, undefined, undefined, ctx);
			await emit("tool_result", { toolName: name, input: args, ...result, isError: false });
			await emit("tool_execution_end", { toolName: name, args, result, isError: false });
			entries.push({ type: "message", message: { role: "toolResult", toolName: name, toolCallId: "call", ...result, isError: false } });
			return result;
		},
	};
}

test("fresh Plan sessions receive full guidance before accepted scope becomes a saved plan", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-fresh-guidance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		await h.command("");
		const discussion = await h.prompt("Could reward names show item hover previews?");
		const guidance = discussion.find((m: any) => m.customType === "pi-plan-build-task").content;
		assert.match(guidance, /## Finalization/);
		assert.match(guidance, /## Verification policy/);
		assert.match(guidance, /Current plan: none/);
		assert.match(guidance, /expectedAttached: null/);
		assert.match(guidance, /informational agreement, or discussion alone does not create a task/);
		assert.match(guidance, /scope for plan preparation, not implementation/);
		assert.match(guidance, /call plan_exit/);
		assert.match(guidance, /Do not wait for the exact words/);
		assert.equal(h.state().collection.attached, null);
		assert.deepEqual(h.state().collection.records, []);
		const file = makePlanPath(path.join(dir, "plans"), "session", 1);
		assert.equal(fs.existsSync(file), false);
		await h.prompt("Approved.");
		assert.equal(h.state().collection.attached, null, "approval interpretation stays agent-assisted, not a keyword trigger");
		const created = await h.callTool("plan_task", { action: "new", expectedAttached: null, title: "Reward hover previews", scope: "Show actual reward item previews" });
		assert.equal(created.details.planPath, file);
		assert.equal(fs.existsSync(file), false);
		// A later tool batch may write only the returned canonical path.
		h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: file } }] } });
		assert.equal(await h.event("tool_call", { toolName: "write", input: { path: file } }), undefined);
		assert.equal((await h.event("tool_call", { toolName: "write", input: { path: path.join(dir, "project.ts") } })).block, true);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "# Reward hover previews\n\n## Verification\nInspect generated hover content.\n\n## Implementation Steps\n1. Add actual item previews.\n");
		await h.event("tool_result", { toolName: "write", input: { path: file }, isError: false });
		assert.equal(h.state().selectedMode, "plan", "saving a plan does not approve implementation");
		const approved = await h.callTool("plan_exit");
		assert.equal(approved.details.approved, true);
		assert.equal(h.state().selectedMode, "build");
		assert.equal(h.record().plan.status, "open");
		await h.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

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
		await h.command("new");
		const file = makePlanPath(path.join(dir, "plans"), "session", 1);
		fs.writeFileSync(file, "# Plan\n");
		const approved = await h.tool("plan_exit");
		assert.match(approved.content[0].text, /^Plan approved; switched to Build mode\./);
		assert.match(approved.content[0].text, /Implement the approved plan now within its authorization boundaries/);
		assert.match(approved.content[0].text, /acknowledgment or initial inspection alone is not completion/);
		assert.match(approved.content[0].text, /Deployment and restarts still require any separately specified approval/);
		assert.notEqual(approved.terminate, true);
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
				const failure = render({ content: [{ type: "text", text: "Actual failure" }, { type: "text", text: "Recovery details" }], details: { planCompleted: true } }, true, true);
				assert.match(failure, /Actual failure[\s\S]*Recovery details/, name);
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

test("composed tool rows have one pending indicator and result-only settled output", async () => {
	initTheme("dark", false);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-result-rows-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		const samples: Record<string, any> = {
			plan_complete: { completed: true }, plan_enter: { mode: "plan" },
			plan_task: { attached: 1 }, plan_finish: { outcome: { kind: "blocked", reason: "Missing input" } },
			plan_step_control: { stepId: "step-2" }, plan_step_complete: { stepId: "step-2", completed: true },
			plan_exit: { approved: true }, question: { answers: [{ header: "Backend", answers: ["SQLite"] }] },
		};
		for (const [name, details] of Object.entries(samples)) {
			const row = new ToolExecutionComponent(name, "row", {}, {}, h.tools.get(name), { requestRender() {} } as any, dir);
			const text = () => row.render(160).join("\n");
			assert.equal((text().match(/…/g) ?? []).length, 1, name);
			const result = { content: [{ type: "text", text: name === "plan_complete" ? "Plan complete." : "Result available" }], details, isError: false };
			const original = structuredClone(result);
			row.updateResult(result as any, true);
			assert.equal((text().match(/…/g) ?? []).length, 1, name);
			assert.doesNotMatch(text(), /Result available|Plan complete\./);
			row.updateResult(result as any, false);
			assert.doesNotMatch(text(), /…|Complete plan|Enter Plan mode|Record plan outcome|Request plan approval|question \(/, name);
			assert.ok(text().trim(), name);
			if (name === "plan_complete") assert.equal((text().match(/Plan complete\./g) ?? []).length, 1);
			if (name.startsWith("plan_step")) assert.match(text(), /Step 2:/);
			row.setExpanded(true);
			assert.ok(text().trim());
			assert.deepEqual(result, original, "rendering never changes model-visible responses");
			for (const partial of [true, false]) {
				row.updateResult({ content: [{ type: "text", text: "Actual error" }], details, isError: true } as any, partial);
				assert.equal((text().match(/Actual error/g) ?? []).length, 1, name);
				assert.doesNotMatch(text(), /…/);
			}
		}
		await h.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("correlated approval and cancellation notices suppress empty rows across restoration", async () => {
	initTheme("dark", false);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-notice-rows-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		await h.command("new");
		fs.writeFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), "# Approved plan\n");
		const approved = await h.tool("plan_exit");
		h.ctx.ui.select = async () => undefined as any;
		const cancelled = await h.tool("question", { questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes" }, { label: "No" }] }] });
		for (const current of [h, harness(dir, structuredClone(h.entries))]) {
			if (current !== h) await current.event("session_start", { reason: "reload" });
			for (const [name, result] of [["plan_exit", approved], ["question", cancelled]] as const) {
				const row = new ToolExecutionComponent(name, "id", {}, {}, current.tools.get(name), { requestRender() {} } as any, dir);
				row.updateResult({ ...result, isError: false } as any);
				assert.deepEqual(row.render(120), [], "no empty padded box remains");
				row.setExpanded(true);
				assert.ok(row.render(120).join("").trim(), "expanded details remain available");
				const legacy = new ToolExecutionComponent(name, "uncorrelated-old-call", {}, {}, current.tools.get(name), { requestRender() {} } as any, dir);
				legacy.updateResult({ ...result, isError: false } as any);
				assert.ok(legacy.render(120).join("").trim(), "uncorrelated historical results remain visible");
			}
			await current.event("session_shutdown");
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("operational context precedes the real request and preserves the tool-exchange tail", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-context-order-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		await h.command("new");
		const file = makePlanPath(path.join(dir, "plans"), "session", 1);
		fs.writeFileSync(file, "# Approved plan\n");
		const history: any[] = [
			{ role: "custom", customType: "another-extension", content: "Keep this context", timestamp: 0 },
			{ role: "custom", customType: "pi-plan-build-reminder", content: "Obsolete guidance", timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "Implement the plan" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "project.ts" } }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "File contents" }], isError: false, timestamp: 3 },
		];
		const original = structuredClone(history);
		let result = await h.event("context", { messages: history });
		assert.match(result.messages[1].content, /Plan mode is active/);
		assert.equal(result.messages[2], history[2], "context is before the real user, not the other extension");
		assert.match(result.messages[1].content, /not a new user request.*Do not acknowledge/);
		await h.tool("plan_exit");
		for (let i = 0; i < 3; i++) {
			result = await h.event("context", { messages: result.messages });
			assert.equal(result.messages.filter((m: any) => m.customType === "pi-plan-build-task").length, 1);
			assert.match(result.messages[1].content, /Build mode permits/);
			assert.doesNotMatch(result.messages[1].content, /Plan mode is active/);
			const converted = convertToLlm(result.messages);
			assert.equal(converted[1].role, "user", "Pi converts custom context to user-role content");
			assert.deepEqual(converted.slice(2), convertToLlm(history.slice(2)));
			assert.equal(converted.at(-1)?.role, "toolResult");
		}
		assert.deepEqual(history, original, "stored history is not rewritten");
		await h.tool("plan_task", { action: "update", expectedAttached: 1, title: "Revised identity", scope: "Approved scope" });
		const updated = await h.event("context", { messages: history });
		assert.match(updated.messages[1].content, /Revised identity/);
		const noUser = await h.event("context", { messages: history.slice(3) });
		assert.equal(noUser.messages[0].customType, "pi-plan-build-task");
		assert.deepEqual(noUser.messages.slice(1), history.slice(3));
		await h.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("reconciliation context is limited to its live follow-up, including direct continuations", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-reconcile-context-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		fs.writeFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), "# Approved work\n");
		for (const boundary of ["settled", "user", "reload", "tree", "abandon", "complete", "mode", "interrupted"]) {
			const data = { version: STATE_VERSION, selectedMode: "build", collection: { records: [{ plan: { sequence: 1, status: "open" } }], attached: 1, counter: 1 } };
			const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data }]);
			await h.event("session_start", { reason: "reload" });
			await h.prompt("Implement approved work");
			await h.event("tool_result", { toolName: "edit", input: { path: path.join(dir, "project.ts") }, isError: false });
			await h.event("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
			await h.event("agent_settled");
			const sent = h.events.find(e => e.kind === "internal");
			assert.ok(sent.message.details.reconciliationId);
			const reminder = { role: "custom", ...sent.message, timestamp: 1 };
			const historical = { ...reminder, details: undefined, content: "Old bookkeeping restriction" };
			const messages: any[] = [{ role: "user", content: "Implement approved work", timestamp: 0 }, historical, reminder];
			// sendCustomMessage(triggerTurn) invokes the agent directly: no before_agent_start.
			await h.event("agent_start");
			await h.event("message_start", { message: reminder });
			const outgoing = async () => (await h.event("context", { messages })).messages;
			const live = await outgoing();
			assert.ok(live.includes(reminder), boundary);
			assert.ok(!live.includes(historical), "a live reminder must not reactivate older reminders");
			assert.equal(convertToLlm(live).at(-1)?.role, "user");
			const outcome = await h.callTool("plan_finish", { expectedAttached: 1, outcome: "still_working", reason: "Approved work remains" });
			messages.push({ role: "assistant", content: [{ type: "toolCall", id: "finish", name: "plan_finish", arguments: {} }], timestamp: 2 });
			messages.push({ role: "toolResult", toolCallId: "finish", toolName: "plan_finish", ...outcome, timestamp: 3 });
			assert.ok((await outgoing()).includes(reminder), "keep the boundary through the final bookkeeping response");
			if (boundary === "settled" || boundary === "interrupted") {
				await h.event("agent_end", { messages: [{ role: "assistant", stopReason: boundary === "interrupted" ? "aborted" : "stop", content: [] }] });
				await h.event("agent_settled");
			} else if (boundary === "user") {
				const user = { role: "user", content: "Plan approved; continue", timestamp: 4 };
				messages.push(user);
				await h.event("message_start", { message: user }); // Also covers queued user input without before_agent_start.
			} else if (boundary === "reload") await h.event("session_start", { reason: "reload" });
			else if (boundary === "tree") await h.event("session_tree");
			else if (boundary === "abandon") await h.tool("plan_task", { action: "abandon", expectedAttached: 1, reason: "User cancelled work" });
			else if (boundary === "complete") await h.tool("plan_complete");
			else await h.command("");
			assert.ok(!(await outgoing()).some((m: any) => m.customType === "pi-plan-build-reconcile"), boundary);
			assert.equal(h.events.filter(e => e.kind === "internal").length, 1, "no automatic implementation retry");
			assert.equal(messages.filter(m => m.customType === "pi-plan-build-reconcile").length, 2, "filtering preserves original history");
			await h.event("session_shutdown");
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
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
		for (const skip of ["conversation", "aborted", "error", "tool-error", "pending", "plan", "step", "complete", "blocked"]) {
			const f = fixture() as any[];
			if (skip === "step") f[0].data.execution = createPlanExecution(markdown);
			const check = harness(dir, f);
			await check.event("session_start", { reason: "resume" });
			await check.prompt("Work");
			if (skip !== "conversation") await mutation(check);
			if (skip === "pending") check.ctx.hasPendingMessages = () => true;
			if (skip === "tool-error") await check.event("tool_result", { toolName: "bash", input: {}, isError: true });
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
		const awaiting = await pending.tool("plan_finish", { expectedAttached: 1, outcome: "awaiting_validation", reason: "Hardware needed", userAction: "Run the hardware acceptance check" });
		assert.match(awaiting.content[0].text, /plan remains open/);
		assert.match(awaiting.content[0].text, /Run the hardware acceptance check/);
		await settle(pending);
		assert.equal(pending.state().collection.attached, 1);
		assert.equal(pending.state().collection.records[0].plan.status, "open");
		assert.equal(pending.state().collection.records[0].plan.outcome.userAction, "Run the hardware acceptance check");
		await pending.prompt("Discuss the validation result");
		await pending.event("session_start", { reason: "reload" });
		assert.equal(pending.state().collection.attached, 1);
		assert.equal(pending.state().collection.records.length, 1);
		assert.equal(pending.state().collection.counter, 1);
		assert.equal((await pending.event("tool_call", { toolName: "write", input: { path: file } })).block, true);
		const listed = await pending.tool("plan_task", { action: "list" });
		assert.match(listed.content[0].text, /Current plan: 1 · Work · awaiting validation/);
		assert.doesNotMatch(listed.content[0].text, /hardware acceptance|\.md/);
		const detailsText = pending.tools.get("plan_task").renderResult(listed, { expanded: true, isPartial: false }, pending.ctx.ui.theme, {}).render(160).join("\n");
		assert.match(detailsText, /Run the hardware acceptance check/);
		const outcomeText = pending.tools.get("plan_finish").renderResult(awaiting, { expanded: true, isPartial: false }, pending.ctx.ui.theme, {}).render(160).join("\n");
		assert.equal((outcomeText.match(/Run the hardware acceptance check/g) ?? []).length, 1);
		assert.equal(detailsText.split(file).length - 1, 1, "expanded inventory shows the current path once");
		const pendingContext = await pending.event("context", { messages: [] });
		assert.match(pendingContext.messages.at(-1).content, /plan remains open and current/);
		assert.match(pendingContext.messages.at(-1).content, /Run the hardware acceptance check/);
		assert.doesNotMatch(pendingContext.messages.at(-1).content, /resume another plan/);
		await pending.tool("plan_complete");
		assert.equal(pending.state().collection.attached, null);
		assert.equal(pending.state().collection.records[0].plan.status, "completed");
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
		const legacy = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data: { version: 1, selectedMode: "build", plan: { sequence: 1, status: "open" } } }]);
		await legacy.event("session_start", { reason: "resume" });
		assert.equal(legacy.state().collection.attached, null);
		assert.deepEqual(legacy.state().collection.records, []);
		assert.equal(legacy.state().collection.counter, 1);
		assert.deepEqual((await legacy.event("context", { messages: [] })).messages, [], "ordinary Build without a current plan has no lifecycle block");
		await legacy.command("");
		assert.match((await legacy.event("context", { messages: [] })).messages.at(-1).content, /Current plan: none/);

		fs.mkdirSync(path.join(dir, "plans"), { recursive: true });
		const inertFile = makePlanPath(path.join(dir, "plans"), "session", 1);
		fs.writeFileSync(inertFile, "# Old paused work\n");
		const inertPlan = { sequence: 1, status: "open", task: { title: "Old paused work", scope: "Preserve only", decisions: [] } };
		const inert = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data: { version: 2, selectedMode: "build", collection: { records: [{ plan: inertPlan }], attached: null, counter: 1 } } }]);
		await inert.event("session_start", { reason: "resume" });
		assert.deepEqual(inert.state().collection.records, [{ plan: inertPlan }]);
		assert.deepEqual((await inert.event("context", { messages: [] })).messages, []);
		assert.equal((await inert.tool("plan_task", { action: "list" })).content[0].text, "Current plan: none.");
		await inert.command("");
		await inert.command("new");
		assert.equal(inert.state().collection.attached, 2);
		assert.deepEqual(inert.state().collection.records[0], { plan: inertPlan }, "detached legacy data remains inert and unchanged");
		assert.equal((await inert.event("tool_call", { toolName: "write", input: { path: inertFile } })).block, true);
		assert.equal(fs.readFileSync(inertFile, "utf8"), "# Old paused work\n");
		for (const kind of ["metadata", "file", "execution", "reservation", "unavailable"] as const) {
			const id = kind;
			const file = makePlanPath(path.join(dir, "plans"), id, 1);
			if (kind === "file") fs.writeFileSync(file, "# Real saved plan\n");
			if (kind === "unavailable") fs.mkdirSync(file);
			const plan = { sequence: 1, status: "open", ...(kind === "metadata" ? { task: { title: "Unsaved planning", scope: "Legitimate scope", decisions: [] } } : {}) };
			const data = { version: 1, selectedMode: kind === "reservation" ? "plan" : "build", plan, ...(kind === "execution" ? { execution: createPlanExecution("# Work\n\n## Implementation Steps\n1. Work\n") } : {}) };
			const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data }], id);
			await h.event("session_start", { reason: "resume" });
			assert.equal(h.state().collection.attached, kind === "reservation" ? null : 1, kind);
			const context = await h.event("context", { messages: [] });
			assert.match(context.messages.at(-1).content, kind === "file" || kind === "execution" ? /Saved plan file/ : kind === "unavailable" ? /Plan file unavailable/ : kind === "reservation" ? /Current plan: none/ : /Do not read this absent file/);
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
		await h.command("new");
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
		await assert.rejects(h.tool("plan_task", { action: "pause", expectedAttached: 1 }), /no longer supported/);
		assert.equal(h.state().collection.attached, 1, "deprecated pause is side-effect free");
		const list = await h.tool("plan_task", { action: "list" });
		assert.match(list.content[0].text, /Current plan: 1 · Fix login · open/);
		assert.doesNotMatch(list.content[0].text, /Build mode permits|paused/);
		const buildContext = await h.event("context", { messages: [] });
		assert.match(buildContext.messages.at(-1).content, /Build mode permits/);
		assert.match(buildContext.messages.at(-1).content, /Current task sequence \(internal\): 1/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the current plan cannot be replaced and explicit abandonment preserves history", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-single-current-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		const fileA = makePlanPath(path.join(dir, "plans"), "session", 1);
		const markdown = "# Login\n\n## Implementation Steps\n1. Fix login\n";
		fs.writeFileSync(fileA, markdown);
		const progress = createPlanExecution(markdown);
		progress.steps[0].status = "active";
		const entries = [{ type: "custom", customType: "pi-plan-build-state", data: { version: 2, selectedMode: "build", planSessionId: "session", collection: { records: [{ plan: { sequence: 1, status: "open", task: { title: "Login", scope: "Login redirects", decisions: [] } }, execution: progress }], attached: 1, counter: 1 } } }];
		const h = harness(dir, entries);
		await h.event("session_start", { reason: "resume" });
		await assert.rejects(h.tool("plan_task", { action: "pause", expectedAttached: 1 }), /no longer supported/);
		assert.equal(h.state().collection.attached, 1);
		await h.command("");
		await assert.rejects(h.tool("plan_task", { action: "new", expectedAttached: 1, title: "Billing", scope: "Export invoices" }), /Complete or explicitly abandon/);
		assert.equal(h.state().collection.records.length, 1);
		await h.command("resume 99");
		assert.match(h.events.filter((e) => e.kind === "notify").at(-1).text, /no longer supported/);
		assert.equal(h.state().collection.attached, 1, "deprecated command is side-effect free");
		h.ctx.ui.confirm = async () => false;
		await h.command("abandon");
		assert.equal(h.state().collection.attached, 1, "cancelled abandonment changes nothing");
		h.ctx.ui.confirm = async () => true;
		const abandoned = await h.tool("plan_task", { action: "abandon", expectedAttached: 1, reason: "User chose to discontinue login work" });
		assert.match(abandoned.content[0].text, /Plan abandoned: Login/);
		assert.equal(h.state().collection.attached, null);
		assert.equal(h.state().collection.records[0].plan.status, "abandoned");
		assert.equal(h.state().collection.records[0].plan.abandonReason, "User chose to discontinue login work");
		assert.equal(h.state().collection.records[0].execution, undefined);
		assert.equal(fs.readFileSync(fileA, "utf8"), markdown);
		await h.tool("plan_task", { action: "new", expectedAttached: null, title: "Billing", scope: "Export invoices" });
		assert.equal(h.state().collection.attached, 2);
		assert.equal(h.state().collection.records.length, 2);
		assert.equal((await h.event("tool_call", { toolName: "write", input: { path: fileA } })).block, true);
		const fileB = makePlanPath(path.join(dir, "plans"), "session", 2);
		fs.writeFileSync(fileB, "# Billing\n");
		const fork = harness(dir, structuredClone(h.entries), "fork");
		await fork.event("session_start", { reason: "fork" });
		assert.equal(fs.readFileSync(makePlanPath(path.join(dir, "plans"), "fork", 1), "utf8"), markdown);
		assert.equal(fs.readFileSync(makePlanPath(path.join(dir, "plans"), "fork", 2), "utf8"), "# Billing\n");
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
		await h.command("new");
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
		await h.tool("plan_finish", { expectedAttached: 1, outcome: "awaiting_validation", reason: "Needs browser confirmation", userAction: "Confirm the login redirect in a browser" });
		assert.equal(status(), "Fix redirects · Awaiting validation");
		await h.event("session_start", { reason: "reload" });
		assert.equal(status(), "Fix redirects · Awaiting validation", "validation status remains visible after restoration");
		await h.tool("plan_complete");
		assert.equal(status(), "build", "completion refreshes status immediately");
		await h.command("");
		assert.equal(status(), "plan", "re-entering Plan after completion has no task label");
		await h.event("session_start", { reason: "reload" });
		assert.equal(status(), "plan", "an empty reserved slot remains untitled without a placeholder after reload");
		await h.command("new");
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
		await h.command("new");
		assert.ok(h.active().includes("plan_task"));
		await h.tool("plan_task", { action: "update", sequence: 1, title: "Fix login redirects", scope: "Fix redirects" });
		const first = makePlanPath(path.join(dir, "plans"), "session", 1);
		assert.equal(fs.existsSync(first), false);
		fs.writeFileSync(first, "# Login plan\n");
		await h.tool("plan_task", { action: "include", sequence: 1, topic: "Logout", scope: "Fix redirects and logout" });
		await h.tool("plan_task", { action: "discussion", sequence: 1, topic: "Billing", scope: "must not replace scope" });
		await h.tool("plan_task", { action: "discussion", sequence: 1, topic: "billing" });
		assert.equal(h.record().plan.task.decisions.length, 2);
		assert.equal(h.record().plan.task.scope, "Fix redirects and logout");
		h.state().collection.records[0].execution = createPlanExecution("# Login\n\n## Implementation Steps\n1. Fix login\n");
		const restored = harness(dir, h.entries);
		await restored.event("session_start", { reason: "resume" });
		assert.ok(restored.record()?.execution);
		const context = await restored.event("context", { messages: [] });
		assert.match(context.messages.at(-1).content, /Fix login redirects/);
		assert.match(context.messages.at(-1).content, /discussion/);
		assert.match(context.messages.at(-1).content, /billing/);
		// Trigger reduced UI to exercise the title-only status fallback.
		restored.ctx.ui.getEditorComponent = () => (() => {}) as any;
		await restored.prompt("Continue discussing");
		assert.ok(restored.events.some((e) => e.kind === "status" && e.text === "Fix login redirects"));
		await assert.rejects(restored.tool("plan_task", { action: "new", sequence: 0, title: "Wrong", scope: "Wrong" }), /Stale/);
		await assert.rejects(restored.tool("plan_task", { action: "new", sequence: 1 }), /Complete or explicitly abandon/);
		restored.ctx.ui.select = async () => PLAN_EXIT_FRESH_CHOICE;
		await restored.tool("plan_exit");
		restored.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "plan_task" }, { type: "toolCall", name: "write" }] } });
		assert.equal((await restored.event("tool_call", { toolName: "write", input: { path: first } })).block, true);
		await restored.tool("plan_task", { action: "abandon", expectedAttached: 1, reason: "User redirected to billing exports" });
		const result = await restored.tool("plan_task", { action: "new", expectedAttached: null, title: "Billing exports", scope: "Export invoices" });
		const second = makePlanPath(path.join(dir, "plans"), "session", 2);
		assert.equal(result.details.planPath, second);
		assert.match(result.content[0].text, /Billing exports/);
		assert.equal(fs.readFileSync(first, "utf8"), "# Login plan\n");
		assert.equal(fs.existsSync(second), false);
		assert.deepEqual(restored.record().plan.task.decisions, []);
		assert.equal(restored.record().plan.status, "open");
		assert.equal(restored.record()?.execution, undefined);
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
		await h.command("new");
		const first = makePlanPath(path.join(dir, "plans"), "session", 1);
		assert.equal(fs.existsSync(first), false, "discussion does not create a file");
		fs.writeFileSync(first, "# First task\n");
		await h.build();
		await h.command("");
		assert.equal(h.record().plan.sequence, 1, "mode toggles resume unfinished work");
		await h.tool("plan_exit");
		assert.equal(h.record().plan.status, "open", "approval is not completion");
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
		assert.equal(h.record().plan.status, "open", "settling is not completion");
		await h.tool("plan_complete");
		assert.equal(h.active().includes("plan_complete"), false);
		assert.equal(fs.readFileSync(first, "utf8"), "# First task\n", "completion preserves the approved plan");
		await h.command("");
		assert.equal(h.state().collection.attached, null);
		await h.command("new");
		assert.equal(h.record().plan.sequence, 2);
		assert.equal(fs.readFileSync(first, "utf8"), "# First task\n");
		await h.event("before_agent_start");
		assert.equal((await h.event("tool_call", { toolName: "write", input: { path: first } })).block, true);
		const second = makePlanPath(path.join(dir, "plans"), "session", 2);
		assert.equal(await h.event("tool_call", { toolName: "write", input: { path: second } }), undefined);
		fs.writeFileSync(second, "# Second task\n");
		await h.event("session_shutdown");
		const restored = harness(dir, h.entries);
		await restored.event("session_start", { reason: "resume" });
		assert.equal(restored.record().plan.sequence, 2);
		restored.setIdle(false);
		await restored.command("new");
		assert.equal(restored.record().plan.sequence, 2, "busy runs cannot change plan identity");
		restored.setIdle(true);
		await restored.command("new");
		assert.equal(restored.record().plan.sequence, 2, "a current plan cannot be silently replaced");
		assert.match(restored.events.filter((e) => e.kind === "notify").at(-1).text, /Complete or explicitly abandon/);
		assert.equal(fs.readFileSync(second, "utf8"), "# Second task\n");
		await restored.build();
		await restored.command("done");
		assert.equal(restored.record().plan.status, "completed");
		await restored.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy unnumbered plans and fork copies preserve the source file", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-legacy-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		const legacy = makePlanPath(path.join(dir, "plans"), "session");
		fs.writeFileSync(legacy, "legacy plan");
		const h = harness(dir);
		await h.event("session_start", { reason: "resume" });
		assert.equal(h.record().plan.sequence, 0);
		await h.event("session_shutdown");
		const fork = harness(dir, structuredClone(h.entries), "child");
		await fork.event("session_start", { reason: "fork" });
		assert.equal(fs.readFileSync(makePlanPath(path.join(dir, "plans"), "child"), "utf8"), "legacy plan");
		await fork.command("done");
		assert.equal(fork.record().plan.status, "completed");
		await fork.command("");
		assert.equal(fork.state().collection.attached, null);
		await fork.command("new");
		assert.equal(fork.record().plan.sequence, 1);
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
		const transition = h.events.length;
		await h.tool("plan_step_control", { action: "complete" });
		assert.equal(h.events.slice(transition).filter(e => e.kind === "entry" && e.customType === "pi-plan-build-state").length, 1);
		assert.equal(h.events.slice(transition).filter(e => e.kind === "tools").length, 1);
		assert.ok(!h.active().includes("plan_step_control"));
		assert.ok(!h.active().includes("plan_complete"));
		assert.equal(h.record().plan.status, "completed");
		assert.equal(h.record()?.execution, undefined);
		assert.equal(fs.readFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), "utf8"), markdown, "step completion leaves the numbered plan unchanged");
		await h.command("");
		assert.equal(h.state().collection.attached, null);
		await h.command("new");
		assert.equal(h.record().plan.sequence, 2);
		await h.event("session_shutdown");
		const cancelled = harness(dir, structuredClone(entries));
		await cancelled.event("session_start", { reason: "resume" });
		const cancellation = cancelled.events.length;
		await cancelled.tool("plan_step_control", { action: "cancel" });
		assert.equal(cancelled.events.slice(cancellation).filter(e => e.kind === "entry" && e.customType === "pi-plan-build-state").length, 1);
		assert.equal(cancelled.events.slice(cancellation).filter(e => e.kind === "tools").length, 1);
		assert.ok(cancelled.active().includes("plan_complete"));
		assert.ok(!cancelled.active().includes("plan_step_control"));
		assert.equal(cancelled.record().plan.status, "open");
		await cancelled.command("");
		assert.equal(cancelled.record().plan.sequence, 1);
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
				await h.command("new");
				await h.tool("plan_task", { action: "update", sequence: 1, title: "Approved task title", scope: "Implement approved plan" });
				h.ctx.mode = mode;
				h.ctx.ui.select = async () => choice as any;
				fs.writeFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), "# Approved plan\n");
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
						assert.equal(child.state().version, STATE_VERSION);
						assert.equal(child.record().plan.task.title, "Approved task title");
						assert.equal(destination.length, 0);
						await h.event("session_shutdown");
						await child.event("session_start", { reason: "new" });
						assert.equal(child.state().pendingFreshAnnouncement, true);
						assert.equal(child.state().collection.records.length, 1);
						assert.equal(destination.some(e => e.kind === "render" || e.text === PLAN_ACTION_ANNOUNCEMENTS["implement-fresh"]), false);
						await withSession({
							...child.ctx,
							ui: { ...child.ctx.ui, setEditorText() {} },
							sendUserMessage: async (text: string) => {
								const context = await child.prompt(text);
								assert.ok(context.some((message: any) => message.role === "user" && message.content === text));
								assert.ok(context.some((message: any) => message.customType === "pi-plan-build-task"));
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
					assert.equal(destination.filter(e => e.kind === "notify" && e.text.startsWith("Fresh implementation session started with plan")).length, mode === "rpc" ? 1 : 0);
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
		assert.deepEqual(context.messages, keep.filter((message) => message.customType !== "pi-plan-build-reminder"));
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
		await h.command("new");
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

test("accumulated context is current, bounded, and read-only with one snapshot per transition", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-context-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const h = harness(dir);
		await h.event("session_start", { reason: "startup" });
		const snapshots = () => h.events.filter((e) => e.kind === "entry" && e.customType === "pi-plan-build-state").length;
		assert.equal(snapshots(), 0);
		assert.deepEqual(await h.prompt("Explain this code"), [{ role: "user", content: "Explain this code" }]);
		await h.callTool("plan_enter");
		let count = snapshots();
		await h.callTool("plan_task", { action: "new", expectedAttached: null, title: "Stable task", scope: "Stable scope" });
		assert.equal(snapshots(), count + 1, "new plus metadata commits once");
		assert.equal(h.state().version, 3);
		assert.equal("plan" in h.state(), false);
		assert.equal("execution" in h.state(), false);
		const obsolete = { role: "custom", customType: "pi-plan-build-reminder", content: "Obsolete implementation" };
		h.entries.push({ type: "custom_message", ...obsolete });
		h.entries.push({ type: "custom_message", role: "custom", customType: "another-extension", content: "Keep other guidance" });
		count = snapshots();
		let size = 0;
		for (let i = 0; i < 4; i++) {
			const context = await h.prompt(`Discuss ${i}`);
			const blocks = context.filter((m: any) => m.customType === "pi-plan-build-task");
			assert.equal(blocks.length, 1);
			assert.match(blocks[0].content, /Plan mode is active/);
			assert.doesNotMatch(JSON.stringify(context), /Obsolete implementation/);
			assert.ok(context.some((m: any) => m.customType === "another-extension"));
			if (size) assert.equal(blocks[0].content.length, size);
			size = blocks[0].content.length;
		}
		assert.ok(h.entries.some((entry) => entry.content === "Obsolete implementation"), "transcript history is not deleted");
		await h.callTool("plan_task", { action: "list" });
		await h.callTool("plan_task", { action: "update", expectedAttached: 1, title: "Stable task", scope: "Stable scope" });
		assert.equal(snapshots(), count, "read/list/context/no-op do not persist");
		fs.mkdirSync(path.join(dir, "plans"), { recursive: true });
		const file = makePlanPath(path.join(dir, "plans"), "session", 1);
		fs.writeFileSync(file, "# Stable task\n");
		await h.event("tool_result", { toolName: "write", input: { path: file }, isError: false });
		const originalStat = fs.statSync;
		let inspections = 0;
		fs.statSync = ((...args: any[]) => { inspections++; return (originalStat as any)(...args); }) as any;
		try {
			for (let i = 0; i < 5; i++) await h.event("context", { messages: [] });
			assert.equal(inspections, 0, "model requests do not inspect plan files");
			await h.tool("plan_task", { action: "list" });
			assert.equal(inspections, 0, "current-plan status reuses the cached file state");
		} finally { fs.statSync = originalStat; }
		await h.callTool("plan_exit");
		assert.ok(h.active().includes("plan_complete"));
		await h.callTool("plan_complete");
		assert.deepEqual((await h.event("context", { messages: [] })).messages, []);
		assert.equal(h.state().collection.attached, null);
		await h.callTool("plan_enter");
		const context = await h.event("context", { messages: [] });
		assert.doesNotMatch(context.messages[0].content, /Stable task|session-001/);
		assert.match(context.messages[0].content, /No canonical writable plan path/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("canonical aliases obey Plan and Build guards for new, current, and historical files", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-alias-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const h = harness(dir);
	try {
		await h.event("session_start", { reason: "startup" });
		await h.command("new");
		const file = makePlanPath(path.join(dir, "plans"), "session", 1);
		const shorthand = `@~/${path.relative(os.homedir(), file)}`;
		fs.symlinkSync(path.join(dir, "plans"), path.join(dir, "alias-dir"), "dir");
		for (const toolName of ["write", "edit"]) {
			for (const alias of [shorthand, path.join(dir, "alias-dir", path.basename(file))]) {
				assert.equal((await h.event("tool_call", { toolName, input: { path: alias } }))?.block, undefined);
			}
		}
		fs.writeFileSync(file, "# Plan");
		fs.symlinkSync(file, path.join(dir, "alias.md"));
		await h.build();
		for (const historical of [false, true]) {
			if (historical) await h.command("done");
			for (const toolName of ["write", "edit"]) {
				for (const alias of [shorthand, path.join(dir, "alias.md")]) {
					assert.equal((await h.event("tool_call", { toolName, input: { path: alias } })).block, true);
				}
			}
		}
	} finally {
		await h.event("session_shutdown");
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("current-version successive forks persist child provenance without redundant reload snapshots", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-provenance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const instances: ReturnType<typeof harness>[] = [];
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		const file = (id: string) => makePlanPath(path.join(dir, "plans"), id, 1);
		fs.writeFileSync(file("A"), "# Source A");
		const entries = [{ type: "custom", customType: "pi-plan-build-state", data: {
			version: STATE_VERSION, selectedMode: "plan", planSessionId: "A", toolsBeforeModes: ["read", "write", "edit", "bash"],
			collection: { records: [{ plan: { sequence: 1, status: "open" } }], attached: 1, counter: 1 },
		} }];
		const b = harness(dir, entries, "B"); instances.push(b);
		await b.event("session_start", { reason: "fork" });
		assert.equal(b.state().planSessionId, "B");
		assert.equal(entries.filter(e => e.customType === "pi-plan-build-state").length, 2);
		fs.writeFileSync(file("B"), "# Revised in B");
		const reloaded = harness(dir, structuredClone(b.entries), "B"); instances.push(reloaded);
		await reloaded.event("session_start", { reason: "reload" });
		assert.equal(reloaded.events.filter(e => e.customType === "pi-plan-build-state").length, 0);
		const c = harness(dir, structuredClone(reloaded.entries), "C"); instances.push(c);
		await c.event("session_start", { reason: "fork" });
		assert.equal(c.state().planSessionId, "C");
		assert.equal(fs.readFileSync(file("C"), "utf8"), "# Revised in B");
		assert.equal(fs.readFileSync(file("A"), "utf8"), "# Source A");
	} finally {
		for (const h of instances) await h.event("session_shutdown");
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("RPC approval carries the complete review in its blocking request without changing cancellation", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-rpc-review-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const h = harness(dir);
	try {
		await h.event("session_start", { reason: "startup" });
		await h.command("new");
		const plan = `# Full review\n${"A long instruction.\n".repeat(4000)}FINAL LINE`;
		fs.writeFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), plan);
		const requests: Array<{ title: string; options: string[] }> = [];
		h.ctx.ui.select = (async (title: string, options: string[]) => {
			requests.push(JSON.parse(JSON.stringify({ title, options })));
			return undefined;
		}) as any;
		const result = await h.callTool("plan_exit");
		assert.equal(requests.length, 1);
		assert.ok(requests[0].title.startsWith(`# Plan for Review\n\n${plan}\n\n`));
		assert.deepEqual(requests[0].options, [PLAN_EXIT_APPROVE_CHOICE, PLAN_EXIT_FRESH_CHOICE, PLAN_EXIT_STAY_CHOICE]);
		assert.equal(result.terminate, true);
		assert.equal(result.details.approved, false);
		assert.equal(h.state().selectedMode, "plan");
	} finally {
		await h.event("session_shutdown");
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("paused active steps block both shells and edits until explicit resume; stale revisions preserve bytes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-paused-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		const file = makePlanPath(path.join(dir, "plans"), "session", 1);
		const markdown = "# Steps\n## Implementation Steps\n1. First\n2. Second\n";
		fs.writeFileSync(file, markdown);
		const execution = createPlanExecution(markdown);
		execution.steps[0].status = "active";
		const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data: { version: 1, selectedMode: "build", plan: { sequence: 1, status: "open" }, execution } }]);
		await h.event("session_start", { reason: "resume" });
		await h.callTool("plan_step_control", { action: "pause" });
		assert.ok(!h.active().includes("plan_step_complete"));
		const context = await h.prompt("Discuss progress");
		const operational = context.find((m: any) => m.customType === "pi-plan-build-task");
		assert.match(operational.content, /execution is paused/);
		assert.doesNotMatch(operational.content, /Implement only step|Build mode permits/);
		for (const toolName of ["edit", "write", "bash", "powershell"]) {
			assert.equal((await h.event("tool_call", { toolName, input: { path: path.join(dir, "project.ts"), command: "echo test" } })).block, true);
		}
		await assert.rejects(h.tool("plan_step_complete", { summary: "Not eligible" }), /No plan step/);
		await h.callTool("plan_step_control", { action: "resume" });
		assert.ok(h.active().includes("plan_step_complete"));
		assert.match((await h.event("context", { messages: [] })).messages[0].content, /Implement only step 1/);
		const waiting = await h.callTool("plan_finish", { expectedAttached: 1, outcome: "awaiting_validation", reason: "Needs user observation", userAction: "Confirm that the first step behaves correctly" });
		assert.match(waiting.content[0].text, /This step's implementation is finished/);
		assert.match(waiting.content[0].text, /plan remains open/);
		const cancelled = harness(dir, structuredClone(h.entries));
		await cancelled.event("session_start", { reason: "reload" });
		await cancelled.callTool("plan_step_control", { action: "cancel" });
		assert.equal(cancelled.record().plan.status, "open");
		assert.equal(cancelled.record().plan.outcome.userAction, "Confirm that the first step behaves correctly");
		const cancelledContext = (await cancelled.event("context", { messages: [] })).messages[0].content;
		assert.match(cancelledContext, /only after all approved implementation and required verification/);
		assert.match(cancelledContext, /cancelled step execution is not evidence/);
		await cancelled.event("session_shutdown");
		assert.equal(h.state().collection.attached, 1);
		assert.equal(h.record().execution.status, "paused");
		assert.ok(h.active().includes("plan_step_complete"), "user-confirmed active validation can complete without resuming implementation");
		assert.equal((await h.event("tool_call", { toolName: "edit", input: { path: path.join(dir, "project.ts") } })).block, true);
		assert.match((await h.event("context", { messages: [] })).messages[0].content, /Confirm that the first step behaves correctly/);
		await h.callTool("plan_step_complete", { summary: "User confirmed the first step" });
		assert.equal(h.record().plan.outcome, undefined);
		assert.equal(h.record().execution.status, "running");
		assert.equal(h.record().execution.steps[0].status, "completed");
		assert.equal(h.record().execution.steps[1].status, "ready");
		const changed = markdown.replace("2. Second", "2. Different instruction");
		fs.writeFileSync(file, changed);
		await assert.rejects(h.callTool("plan_step_control", { action: "revise", instruction: "Revised" }), /changed/);
		assert.equal(fs.readFileSync(file, "utf8"), changed);
		const beforeRevision = structuredClone(h.record().execution);
		const unrelatedChange = markdown.replace("1. First", "1. Changed elsewhere");
		fs.writeFileSync(file, unrelatedChange);
		await assert.rejects(h.callTool("plan_step_control", { action: "revise", instruction: "Revised" }), /changed/);
		assert.equal(fs.readFileSync(file, "utf8"), unrelatedChange);
		assert.deepEqual(h.record().execution, beforeRevision);
		fs.writeFileSync(file, markdown);
		await assert.rejects(h.callTool("plan_step_control", { action: "revise", instruction: "first" }), /Duplicate/);
		assert.equal(fs.readFileSync(file, "utf8"), markdown);
		assert.deepEqual(h.record().execution, beforeRevision);
		await h.callTool("plan_step_control", { action: "revise", instruction: "Revised" });
		assert.equal(fs.readFileSync(file, "utf8"), markdown.replace("Second", "Revised"));
		assert.equal(h.record().execution.planMarkdown, fs.readFileSync(file, "utf8"));
		assert.deepEqual(h.record().execution.steps.map((s: any) => s.text), ["First", "Revised"]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("failed user validation resumes the same active step for remediation", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-validation-remediation-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(dir, "plans"));
		const markdown = "# Validate\n## Implementation Steps\n1. Check behavior\n";
		fs.writeFileSync(makePlanPath(path.join(dir, "plans"), "session", 1), markdown);
		const execution = createPlanExecution(markdown);
		execution.steps[0].status = "active";
		const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data: { version: 1, selectedMode: "build", plan: { sequence: 1, status: "open" }, execution } }]);
		await h.event("session_start", { reason: "resume" });
		await h.callTool("plan_finish", { expectedAttached: 1, outcome: "awaiting_validation", reason: "Needs user observation", userAction: "Report whether the behavior fails" });
		assert.equal(h.record().execution.status, "paused");
		await h.callTool("plan_step_control", { action: "resume" });
		assert.equal(h.record().execution.status, "running");
		assert.equal(h.record().execution.steps[0].status, "active");
		assert.equal(h.record().plan.outcome, undefined);
		assert.equal(await h.event("tool_call", { toolName: "edit", input: { path: path.join(dir, "project.ts") } }), undefined);
		await h.callTool("plan_finish", { expectedAttached: 1, outcome: "awaiting_validation", reason: "Recheck", userAction: "Confirm the fix" });
		await h.callTool("plan_step_control", { action: "complete" });
		assert.equal(h.state().collection.attached, null);
		assert.equal(h.record().plan.status, "completed");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("current-format restoration fails closed and unchanged reloads do not persist", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-version-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const collection of [undefined, null, {}]) {
			const data = { version: STATE_VERSION, selectedMode: "build", plan: { sequence: 1, status: "open" }, ...(collection !== undefined ? { collection } : {}) };
			assert.throws(() => restoreCollection(data as any, () => "absent"), /Malformed plan collection/);
			const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data }]);
			await h.event("session_start", { reason: "reload" });
			assert.equal(h.events.filter(e => e.kind === "entry").length, 0);
			await h.event("session_shutdown");
		}
		const data = { version: STATE_VERSION, selectedMode: "build", collection: { records: [{ plan: { sequence: 1, status: "open", task: { title: "Current", scope: "Scope", decisions: [] } } }], attached: 1, counter: 1 } };
		const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data }]);
		for (let i = 0; i < 3; i++) await h.event("session_start", { reason: "reload" });
		assert.equal(h.events.filter(e => e.kind === "entry").length, 0);
		await h.event("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("restoration inspects only current files and preserves inert legacy selection data", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-restore-inspection-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const originalStat = fs.statSync;
	try {
		const markdown = "## Implementation Steps\n1. Historical step\n";
		const inert = { plan: { sequence: 1, status: "open" }, execution: { ...createPlanExecution(markdown), selectedStepId: "step-1" } };
		const current = { plan: { sequence: 2, status: "open", task: { title: "Current", scope: "Scope", decisions: [] } } };
		const data = { version: STATE_VERSION, selectedMode: "build", collection: { records: [inert, current], attached: 2, counter: 2 } };
		const entries = [
			{ type: "custom", customType: "opencode-modes-state", data: { version: 1, selectedMode: "plan" } },
			{ type: "custom", customType: "pi-plan-build-state", data },
			{ type: "custom", customType: "another-extension", data: {} },
		];
		const h = harness(dir, entries);
		const historicalPath = makePlanPath(path.join(dir, "plans"), "session", 1);
		const currentPath = makePlanPath(path.join(dir, "plans"), "session", 2);
		const inspected: string[] = [];
		fs.statSync = ((...args: any[]) => {
			if ([historicalPath, currentPath].includes(String(args[0]))) inspected.push(String(args[0]));
			return (originalStat as any)(...args);
		}) as any;
		for (const event of ["session_start", "session_tree"]) {
			inspected.length = 0;
			await h.event(event, { reason: "reload" });
			assert.deepEqual(inspected, [currentPath]);
			assert.equal(h.state().selectedMode, "build");
			assert.equal(h.events.filter(e => e.kind === "entry").length, 0);
		}
		await h.callTool("plan_task", { action: "update", expectedAttached: 2, title: "Renamed by user", scope: "Scope" });
		assert.deepEqual(h.state().collection.records[0], inert, "later snapshots preserve inert historical payloads");
		await h.event("session_shutdown");
	} finally {
		fs.statSync = originalStat;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("malformed modern state fails closed and branch allocation reads numeric history only", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-corrupt-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const corrupt = { version: 1, selectedMode: "build", plan: { sequence: 1, status: "open" }, collection: { records: [{ plan: { sequence: 1, status: "open" } }, { broken: true }], counter: 2, attached: 1 } };
		assert.throws(() => restoreCollection(corrupt as any, () => "saved"), /Malformed plan collection/);
		const h = harness(dir, [{ type: "custom", customType: "pi-plan-build-state", data: corrupt }]);
		await h.event("session_start", { reason: "resume" });
		await assert.rejects(h.tool("plan_task", { action: "new", expectedAttached: null, title: "Unsafe", scope: "Unsafe" }), /Malformed/);
		assert.equal(h.events.filter((e) => e.kind === "entry" && e.customType === "pi-plan-build-state").length, 0);
		assert.match((await h.event("context", { messages: [] })).messages[0].content, /state unavailable/);
		const numericOnly = { type: "custom", customType: "pi-plan-build-state", data: { collection: { counter: 9, records: [{ plan: { sequence: 12, get task() { throw new Error("must not decode history"); } }, get execution() { throw new Error("must not decode history"); } }] } } };
		assert.equal(allocationHighWater([numericOnly]), 12);
		const branch = harness(dir);
		branch.ctx.sessionManager.getEntries = () => [numericOnly, ...branch.entries];
		await branch.event("session_start", { reason: "startup" });
		await branch.command("new");
		assert.equal(branch.state().collection.attached, 13);
		assert.equal(branch.state().collection.counter, 13);
		assert.equal(restoreCollection({ version: 1, plan: { sequence: 3, status: "open", outcome: { kind: "blocked", reason: "Unsaved but meaningful" } } }, () => "absent").records.length, 1);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
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
