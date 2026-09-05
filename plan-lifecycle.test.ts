import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import planBuildModes from "./index.ts";
import { createPlanExecution } from "./plan-execution.ts";
import { decodePlanLifecycle, makePlanPath, PLAN_EXIT_APPROVE_CHOICE } from "./utils.ts";

function harness(dir: string, entries: any[] = [], sessionId = "session") {
	process.env.PI_CODING_AGENT_DIR = dir;
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	let active = ["read", "write", "edit", "bash"];
	let idle = true;
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerShortcut() {}, registerFlag() {}, registerEntryRenderer() {},
		getFlag: () => false,
		getActiveTools: () => active,
		setActiveTools: (next: string[]) => { active = next; },
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
	};
	const ctx = {
		mode: "rpc", hasUI: true, cwd: dir, isIdle: () => idle,
		sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => sessionId },
		ui: {
			getEditorComponent: () => undefined, setStatus() {}, notify() {},
			select: async () => PLAN_EXIT_APPROVE_CHOICE,
			theme: { fg: (_: string, text: string) => text, bold: (text: string) => text },
		},
	};
	planBuildModes(pi as any);
	return {
		entries, active: () => active, setIdle: (value: boolean) => { idle = value; },
		event: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
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
		await h.event("agent_settled");
		assert.equal(h.state().plan.status, "open", "settling is not completion");
		await h.tool("plan_complete");
		assert.equal(h.active().includes("plan_complete"), false);
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
		const markdown = "# Task\n\n## Implementation Steps\n- [ ] Implement task\n";
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

test("lifecycle decoding and sequence paths reject invalid state", () => {
	assert.deepEqual(decodePlanLifecycle({ sequence: 2, status: "completed" }), { sequence: 2, status: "completed" });
	for (const sequence of [-1, NaN, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
		assert.equal(decodePlanLifecycle({ sequence, status: "open" }), undefined);
	}
	assert.equal(decodePlanLifecycle({ sequence: 1, status: "unknown" }), undefined);
	assert.throws(() => makePlanPath("/tmp", "session", -1));
	assert.equal(makePlanPath("/tmp", "session", 12), "/tmp/session-012.md");
});
