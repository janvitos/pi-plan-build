import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPlanReminder, PLAN_EXIT_DESCRIPTION } from "./prompts.ts";
import {
	applyManualSelection,
	buildFreshImplementationHandoff,
	buildPlanExitFreshResult,
	buildPlanExitStayResult,
	buildPlanReviewMessage,
	classifyPlanExitChoice,
	decodeModeState,
	formatModeStatus,
	formatQuestionAnswers,
	isAllowedPlanMutation,
	makePlanPath,
	nextMode,
	PLAN_EXIT_APPROVE_CHOICE,
	PLAN_EXIT_FRESH_CHOICE,
	PLAN_EXIT_STAY_ACKNOWLEDGEMENT,
	PLAN_EXIT_STAY_CHOICE,
	sanitizeSessionId,
} from "./utils.ts";

test("mode state decodes current and legacy shapes safely", () => {
	assert.deepEqual(decodeModeState({ version: 1, selectedMode: "plan" }), { version: 1, selectedMode: "plan" });
	assert.deepEqual(decodeModeState({ mode: "build" }), { version: 1, selectedMode: "build" });
	assert.equal(decodeModeState({ selectedMode: "danger" }), undefined);
	assert.equal(decodeModeState(null), undefined);
});

test("session ids produce stable paths inside the plan root", () => {
	const root = path.join(os.tmpdir(), "pi-plans");
	const first = makePlanPath(root, "session/../../escape");
	assert.equal(path.dirname(first), path.resolve(root));
	assert.equal(first, makePlanPath(root, "session/../../escape"));
	assert.equal(sanitizeSessionId("../"), "ephemeral");
});

test("only the exact plan path can be mutated", () => {
	const cwd = path.resolve("/tmp/project");
	const plan = path.resolve(cwd, ".pi/plans/session.md");
	assert.equal(isAllowedPlanMutation(cwd, ".pi/plans/session.md", plan), true);
	assert.equal(isAllowedPlanMutation(cwd, "./.pi/plans/../plans/session.md", plan), true);
	assert.equal(isAllowedPlanMutation(cwd, "@.pi/plans/session.md", plan), true);
	assert.equal(isAllowedPlanMutation(cwd, ".pi/plans/other.md", plan), false);
	assert.equal(isAllowedPlanMutation(cwd, "../../etc/passwd", plan), false);
});

test("manual changes defer run mode while busy", () => {
	assert.deepEqual(applyManualSelection("plan", "build", false), { selectedMode: "plan", runMode: "build" });
	assert.deepEqual(applyManualSelection("plan", undefined, true), { selectedMode: "plan", runMode: "plan" });
	assert.equal(nextMode("build"), "plan");
	assert.equal(nextMode("plan"), "build");
});

test("mode statuses use footer-dim brackets and bold colored labels", () => {
	const theme = {
		fg(color: "dim", text: string) {
			assert.equal(color, "dim");
			return `\x1b[38;2;128;128;128m${text}\x1b[0m`;
		},
		bold(text: string) {
			return `\x1b[1m${text}\x1b[22m`;
		},
	};
	const plan = formatModeStatus("plan", theme);
	const build = formatModeStatus("build", theme);
	assert.equal(
		plan,
		"\x1b[38;2;128;128;128m[\x1b[0m\x1b[38;2;255;215;0m\x1b[1mplan\x1b[22m\x1b[0m\x1b[38;2;128;128;128m]\x1b[0m",
	);
	assert.equal(
		build,
		"\x1b[38;2;128;128;128m[\x1b[0m\x1b[38;2;59;130;246m\x1b[1mbuild\x1b[22m\x1b[0m\x1b[38;2;128;128;128m]\x1b[0m",
	);

	const stripAnsi = (status: string) => status.replaceAll(/\x1b\[[0-9;]*m/g, "");
	assert.equal(stripAnsi(plan), "[plan]");
	assert.equal(stripAnsi(build), "[build]");
	assert.equal(stripAnsi(plan).length, 6);
	assert.equal(stripAnsi(build).length, 7);
	assert.doesNotMatch(plan, /\x1b\[48;/);
	assert.doesNotMatch(build, /\x1b\[48;/);
	assert.equal(plan.includes("\u00a0"), false);
	assert.equal(build.includes("\u00a0"), false);
});

test("plan review preserves the complete plan without truncation", () => {
	const plan = `${"section line\n".repeat(500)}FINAL LINE`;
	const review = buildPlanReviewMessage(plan);
	assert.equal(review, `# Plan for Review\n\n${plan}`);
	assert.equal(review.endsWith("FINAL LINE"), true);
	assert.equal(review.includes("truncated"), false);
});

test("stay acknowledgement is stable and actionable", () => {
	assert.equal(
		PLAN_EXIT_STAY_ACKNOWLEDGEMENT,
		"Staying in Plan mode. Let me know when you’re ready to revise or implement the plan.",
	);
});

test("declining plan exit stays in Plan mode and terminates the run", () => {
	const declined = buildPlanExitStayResult("/tmp/plan.md", false);
	assert.equal(declined.terminate, true);
	assert.deepEqual(declined.details, {
		approved: false,
		mode: "plan",
		planPath: "/tmp/plan.md",
		cancelled: false,
	});
	assert.match(declined.content[0].text, /Stop now and wait for their next message/);

	const cancelled = buildPlanExitStayResult("/tmp/plan.md", true);
	assert.equal(cancelled.terminate, true);
	assert.equal(cancelled.details.cancelled, true);
});

test("plan exit classifies all three choices and fails safe", () => {
	assert.equal(classifyPlanExitChoice(PLAN_EXIT_APPROVE_CHOICE), "implement-here");
	assert.equal(classifyPlanExitChoice(PLAN_EXIT_FRESH_CHOICE), "implement-fresh");
	assert.equal(classifyPlanExitChoice(PLAN_EXIT_STAY_CHOICE), "stay");
	assert.equal(classifyPlanExitChoice(undefined), "stay");
	assert.equal(classifyPlanExitChoice("unexpected value"), "stay");
});

test("fresh implementation selection terminates and preserves the handoff", () => {
	const result = buildPlanExitFreshResult("/tmp/plan.md");
	assert.equal(result.terminate, true);
	assert.deepEqual(result.details, {
		approved: true,
		action: "implement-fresh",
		mode: "plan",
		planPath: "/tmp/plan.md",
	});
	const plan = "first line\nlast line";
	const handoff = buildFreshImplementationHandoff(plan);
	assert.match(handoff, /Full tool access is restored/);
	assert.equal(handoff.endsWith(plan), true);
});

test("plan guidance answers informational questions without creating a plan", () => {
	const reminder = buildPlanReminder("No plan file exists yet.");
	assert.match(reminder, /Only when the current request requires an implementation plan/);
	assert.match(reminder, /answer the question directly instead of starting the workflow below/);
	assert.match(reminder, /You may use read-only tools to inspect the project/);
	assert.match(reminder, /Do not create or update the plan file/);
	assert.match(reminder, /Do not call plan_exit/);
	assert.match(reminder, /Plan mode remains active for future requests/);
	assert.match(PLAN_EXIT_DESCRIPTION, /After directly answering an informational question/);
});

test("question answers use stable model-visible formatting", () => {
	assert.equal(
		formatQuestionAnswers([
			{ question: "Backend?", header: "Backend", answers: ["SQLite", "Redis"], custom: false },
			{ question: "Name?", header: "Name", answers: ["custom"], custom: true },
		]),
		'"Backend?"="SQLite, Redis", "Name?"="custom"',
	);
});
