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
		mode: "rpc", hasUI: true, cwd: dir, isIdle: () => idle,
		model: { provider: "test", id: "test" },
		modelRegistry: { find: () => ({ provider: "test", id: "test" }) },
		sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => sessionId, getSessionFile: () => undefined },
		ui: {
			getEditorComponent: () => undefined, setEditorComponent() {}, setStatus() {},
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
		ctx, pi, events, commands,
		entries, active: () => active, setIdle: (value: boolean) => { idle = value; },
		event: emit,
		prompt: async (text: string) => {
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
				const h = harness(dir);
				await h.event("session_start", { reason: "startup" });
				assert.equal(h.events.some(e => e.customType === "pi-plan-build-notice"), false, "ordinary startup does not announce fresh implementation");
				await h.command("");
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
						assert.equal(destination.length, 0);
						await h.event("session_shutdown");
						await child.event("session_start", { reason: "new" });
						assert.equal(child.state().pendingFreshAnnouncement, true);
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
		assert.deepEqual(context.messages, keep);
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
