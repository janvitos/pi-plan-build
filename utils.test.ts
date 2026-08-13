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
	extractPromptHistory,
	formatFooterCwd,
	formatModeMetadata,
	formatModeRail,
	formatModeTopBorder,
	formatQuestionAnswers,
	formatTokens,
	isAllowedPlanMutation,
	makePlanPath,
	nextMode,
	PLAN_EXIT_APPROVE_CHOICE,
	PLAN_EXIT_FRESH_CHOICE,
	PLAN_EXIT_STAY_ACKNOWLEDGEMENT,
	PLAN_EXIT_STAY_CHOICE,
	renderModeComposer,
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

test("mode composer uses colored rails and mode/thinking metadata", () => {
	const theme = {
		fg(color: "dim", text: string) {
			assert.equal(color, "dim");
			return `\x1b[38;2;128;128;128m${text}\x1b[39m`;
		},
	};
	const thinkingColor = (text: string) => `\x1b[38;2;0;255;0m${text}\x1b[39m`;
	const planRail = formatModeRail("plan");
	const buildRail = formatModeRail("build");
	assert.equal(planRail, "\x1b[38;2;245;167;66m│\x1b[0m");
	assert.equal(buildRail, "\x1b[38;2;92;156;245m│\x1b[0m");
	assert.equal(formatModeTopBorder("plan", 4), "\x1b[38;2;245;167;66m╭──╮\x1b[0m");
	assert.equal(formatModeTopBorder("build", 1), "");
	assert.equal(
		formatModeMetadata("plan", "high", theme, thinkingColor),
		"\x1b[38;2;245;167;66m│\x1b[0m \x1b[38;2;245;167;66mplan\x1b[0m\x1b[38;2;128;128;128m · \x1b[39m\x1b[38;2;0;255;0mhigh\x1b[39m",
	);
	assert.equal(
		formatModeMetadata("build", "medium", theme, thinkingColor, {
			modelName: "gpt-5.6-sol",
			modelProvider: "openai",
		}),
		"\x1b[38;2;92;156;245m│\x1b[0m \x1b[38;2;92;156;245mbuild\x1b[0m\x1b[38;2;128;128;128m • \x1b[39mgpt-5.6-sol\x1b[38;2;128;128;128m [openai]\x1b[39m\x1b[38;2;128;128;128m • \x1b[39m\x1b[38;2;0;255;0mmedium\x1b[39m",
	);
});

test("footer helpers preserve compact counts and safe home-relative paths", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1500), "1.5k");
	assert.equal(formatTokens(15000), "15k");
	assert.equal(formatTokens(1_500_000), "1.5M");
	assert.equal(formatFooterCwd("/home/user/project", "/home/user"), `~${path.sep}project`);
	assert.equal(formatFooterCwd("/home/username/project", "/home/user"), "/home/username/project");
});

test("mode composer completes the frame with rounded corners", () => {
	const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
	const lineWidth = {
		truncate: (line: string, width: number) => line.replace(ansiPattern, "").length <= width ? line : line.slice(0, width),
		measure: (line: string) => line.replace(ansiPattern, "").length,
	};
	const lines = ["top border", "  first", "  second", "────────────────", "  autocomplete"];
	assert.deepEqual(renderModeComposer(lines, "╭──────────────╮", "│ ", "│", "│ plan · high", 2, 16, lineWidth), [
		"╭──────────────╮",
		"│ first        │",
		"│ second       │",
		"│              │",
		"│ plan · high  │",
		"╰──────────────╯",
		"",
		"  autocomplete",
	]);
	assert.deepEqual(
		renderModeComposer(
			["top", "  prompt", "\x1b[38;2;128;128;128m────\x1b[0m"],
			"╭──╮",
			"│ ",
			"│",
			"metadata",
			2,
			4,
			lineWidth,
		),
		["╭──╮", "│ p│", "│  │", "met│", "\x1b[38;2;128;128;128m╰──╯\x1b[0m", ""],
	);
	assert.deepEqual(renderModeComposer(lines, "top", "│ ", "│", "metadata", 0, 16, lineWidth), lines);
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

test("prompt history restores normalized user text in chronological order", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ignore" }] } },
		{ type: "message", message: { role: "user", content: "  first prompt  " } },
		{ type: "custom_message", content: "ignore injected context" },
		{
			type: "message",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "second " },
					{ type: "image", data: "...", mimeType: "image/png" },
					{ type: "text", text: "prompt" },
				],
			},
		},
		{ type: "message", message: { role: "user", content: "second prompt" } },
		{ type: "message", message: { role: "user", content: [{ type: "image", data: "..." }] } },
	];
	assert.deepEqual(extractPromptHistory(entries), ["first prompt", "second prompt"]);
});

test("prompt history keeps the latest 100 entries", () => {
	const entries = Array.from({ length: 105 }, (_, index) => ({
		type: "message",
		message: { role: "user", content: `prompt ${index}` },
	}));
	const history = extractPromptHistory(entries);
	assert.equal(history.length, 100);
	assert.equal(history[0], "prompt 5");
	assert.equal(history.at(-1), "prompt 104");
	assert.deepEqual(extractPromptHistory(entries, 2), ["prompt 103", "prompt 104"]);
	assert.deepEqual(extractPromptHistory(entries, 0), []);
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
