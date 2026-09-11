import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModeSelections, parseModeSelections } from "./mode-selection.ts";

test("mode settings validate and default off", () => {
	assert.deepEqual(parseModeSelections(undefined), { enabled: false });
	for (const value of [null, [], true, { enabled: "yes" }, { enabled: true, plan: { provider: "p", modelId: "m", thinkingLevel: "wrong" } }]) assert.throws(() => parseModeSelections(value));
});

test("queued mode changes converge on the latest destination", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-selection-queue-"));
	try {
		const pair = (modelId: string) => ({ provider: "p", modelId, thinkingLevel: "medium" });
		fs.writeFileSync(path.join(dir, "pi-plan-build.json"), JSON.stringify({ modeSelections: { enabled: true, plan: pair("planner"), build: pair("builder") } }));
		let release!: () => void;
		const waiting = new Promise<void>(resolve => { release = resolve; });
		const ctx: any = { model: { provider: "p", id: "builder" }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) }, ui: { notify() {} } };
		const pi: any = { getThinkingLevel: () => "medium", setThinkingLevel() {}, setModel: async (model: any) => { if (model.id === "planner") await waiting; ctx.model = model; return true; } };
		const selections = createModeSelections(pi, dir, () => "build");
		selections.restore(ctx);
		const first = selections.apply("plan", ctx);
		await Promise.resolve();
		const second = selections.apply("build", ctx);
		release();
		await Promise.all([first, second]);
		assert.equal(ctx.model.id, "builder");
		selections.dispose();
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unavailable models preserve preferences, auth failures propagate, clamping is explicit", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-selection-failure-"));
	try {
		const file = path.join(dir, "pi-plan-build.json");
		const target = { provider: "p", modelId: "target", thinkingLevel: "high" };
		fs.writeFileSync(file, JSON.stringify({ modeSelections: { enabled: true, plan: target } }));
		let available = false, authorized = false;
		let thinking = "medium";
		const notices: string[] = [];
		const ctx: any = { model: { provider: "p", id: "original" }, ui: { notify: (text: string) => notices.push(text) }, modelRegistry: { find: () => available ? { provider: "p", id: "target" } : undefined } };
		const pi: any = { getThinkingLevel: () => thinking, setModel: async (model: any) => { if (!authorized) return false; ctx.model = model; return true; }, setThinkingLevel: () => { thinking = "off"; } };
		const selections = createModeSelections(pi, dir, () => "build");
		await assert.rejects(selections.apply("plan", ctx), /unavailable/);
		available = true;
		await assert.rejects(selections.apply("plan", ctx), /authentication/);
		assert.deepEqual(selections.pair("plan"), target);
		authorized = true;
		await selections.apply("plan", ctx);
		assert.equal(selections.pair("plan")?.thinkingLevel, "off");
		assert.ok(notices.some(text => text.includes("adjusted to off")));
		selections.dispose();
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("remember independent user choices, disable without routing, preserve configuration", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-selections-"));
	try {
		const file = path.join(dir, "pi-plan-build.json");
		fs.writeFileSync(file, JSON.stringify({ showPlanTitle: true }));
		let mode: "plan" | "build" = "build";
		let thinking: any = "medium";
		const calls: string[] = [];
		const ctx: any = { model: { provider: "p", id: "one" }, modelRegistry: { find: (provider: string, id: string) => id === "missing" ? undefined : { provider, id } }, ui: { notify() {} } };
		let selection: ReturnType<typeof createModeSelections>;
		const pi: any = { getThinkingLevel: () => thinking, setThinkingLevel: (level: string) => { thinking = level; selection.changed(ctx); }, setModel: async (model: any) => { ctx.model = model; calls.push(model.id); selection.changed(ctx); return true; } };
		selection = createModeSelections(pi, dir, () => mode);
		selection.restore(ctx);
		await selection.apply("plan", ctx);
		assert.deepEqual(calls, []);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).modeSelections, undefined);
		selection.setEnabled(true, ctx);
		await selection.apply("plan", ctx); mode = "plan";
		ctx.model = { provider: "p", id: "two" }; thinking = "high"; selection.changed(ctx);
		await selection.apply("build", ctx); mode = "build";
		assert.equal(ctx.model.id, "one"); assert.equal(thinking, "medium");
		await selection.apply("plan", ctx); mode = "plan";
		assert.equal(ctx.model.id, "two"); assert.equal(thinking, "high");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).showPlanTitle, true);
		selection.setEnabled(false, ctx);
		const count = calls.length;
		await selection.apply("build", ctx);
		assert.equal(calls.length, count);
		selection.dispose();
		fs.writeFileSync(file, "broken JSON");
		const broken = createModeSelections(pi, dir, () => mode);
		assert.equal(broken.enabled, false); assert.ok(broken.warning);
		assert.throws(() => broken.setEnabled(true, ctx));
		assert.equal(fs.readFileSync(file, "utf8"), "broken JSON");
		broken.dispose();
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
