import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import { buildPlanContext } from "./plan-context.ts";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import {
	buildPlanReminder,
	buildPlanStepReminder,
	buildPlanStepWaitingReminder,
	PLAN_EXIT_DESCRIPTION,
	PLAN_STEP_COMPLETE_DESCRIPTION,
	VERIFICATION_GUIDANCE,
} from "./prompts.ts";
import {
	applyManualSelection,
	buildFreshImplementationHandoff,
	buildFreshImplementationRequest,
	buildPlanExitFreshResult,
	buildPlanExitStayResult,
	buildPlanReviewMessage,
	classifyPlanExitChoice,
	decodeModeState,
	decodePlanCollection,
	decodePlanLifecycle,
	displayedPlanTitle,
	extractPlanTitle,
	extractPromptHistory,
	formatModeMetadata,
	formatModeRail,
	formatModeTopBorder,
	formatPlanLabel,
	smallCapsTitle,
	formatQuestionAnswers,
	isAllowedPlanMutation,
	makePlanPath,
	nextMode,
	normalizePlanExitChoice,
	PLAN_EXIT_APPROVE_CHOICE,
	PLAN_EXIT_FRESH_CHOICE,
	PLAN_EXIT_STAY_ACKNOWLEDGEMENT,
	PLAN_EXIT_STAY_CHOICE,
	PLAN_ACTION_ANNOUNCEMENTS,
	PLAN_STEP_READY_ACKNOWLEDGEMENT,
	ownsUiSlot,
	renderModeComposer,
	sanitizeSessionId,
	shouldReduceOptionalUi,
} from "./utils.ts";

test("plan guards normalize Pi paths and resolve filesystem aliases without authorizing unresolved targets", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-paths-"));
	try {
		const file = path.join(dir, "plan file.md");
		fs.writeFileSync(file, "# Plan");
		const homePath = `~/${path.relative(os.homedir(), file)}`;
		for (const alias of [file, homePath, `@${homePath}`, pathToFileURL(file).href, file.replace("plan file", "plan\u202Ffile")]) {
			assert.equal(isAllowedPlanMutation(dir, alias, file), true, alias);
		}
		fs.symlinkSync(file, path.join(dir, "alias.md"));
		fs.symlinkSync(dir, path.join(dir, "alias-dir"), "dir");
		assert.equal(isAllowedPlanMutation(dir, "alias.md", file), true);
		assert.equal(isAllowedPlanMutation(dir, "alias-dir/new/nested.md", path.join(dir, "new/nested.md")), true);
		assert.equal(isAllowedPlanMutation(dir, "other.md", file), false);
		fs.symlinkSync("missing.md", path.join(dir, "dangling.md"));
		assert.throws(() => isAllowedPlanMutation(dir, "dangling.md", file), /dangling/);
		fs.symlinkSync("loop.md", path.join(dir, "loop.md"));
		assert.throws(() => isAllowedPlanMutation(dir, "loop.md", file), /ELOOP/);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("small caps affect only supported outline letters and can be disabled", () => {
	const theme = { bold: (s: string) => s, fg: (_: string, s: string) => s };
	assert.equal(smallCapsTitle("ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz"), "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘQʀꜱᴛᴜᴠᴡXʏᴢ ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘqʀꜱᴛᴜᴠᴡxʏᴢ");
	assert.equal(smallCapsTitle("Été 修復 🔑 123!?"), "Éᴛé 修復 🔑 123!?");
	const title = "Plan Title QX";
	assert.match(formatModeTopBorder("plan", 80, "╮", theme, title, true), /ᴘʟᴀɴ ᴛɪᴛʟᴇ QX · Awaiting validation/);
	assert.match(formatModeTopBorder("plan", 80, "╮", theme, title, true, false), /Plan Title QX · Awaiting validation/);
	assert.equal(formatPlanLabel(title, true), "Plan Title QX · Awaiting validation");
});

test("validation status survives long titles and narrow Unicode layouts", () => {
	const theme = { bold: (s: string) => s, fg: (_: string, s: string) => s };
	const title = "A".repeat(160);
	assert.match(formatModeTopBorder("build", 220, "╮", theme, title, true), /Awaiting validation/);
	assert.equal(formatPlanLabel(title, true), `${title} · Awaiting validation`);
	for (const width of [1, 2, 3, 4, 8, 20, 24, 40, 70, 220]) {
		const line = formatModeTopBorder("build", width, "╮", theme, "修復 🔑".repeat(40), true);
		assert.ok(visibleWidth(line) <= width);
		if (width >= 24) assert.match(line, /Awaiting validation/);
	}
});

test("plan border shows only a safe title and fits narrow Unicode layouts", () => {
	const theme = { bold: (s: string) => s, fg: (_: string, s: string) => s };
	const titled = formatModeTopBorder("plan", 60, "╮", theme, "Fix login redirects");
	assert.match(titled, /ꜰɪx ʟᴏɢɪɴ ʀᴇᴅɪʀᴇᴄᴛꜱ/);
	assert.doesNotMatch(titled, /Plan|#003/);
	for (const mode of ["plan", "build"] as const) for (const width of [1, 2, 3, 4, 8, 20, 60]) {
		const line = formatModeTopBorder(mode, width, "╮", theme, "修復 🔑\n\x1b[31mlogin\x07 redirects");
		assert.ok(visibleWidth(line) <= width);
		// truncateToWidth emits its own SGR resets; user-supplied controls must not survive.
		assert.doesNotMatch(line.replaceAll("\x1b[0m", ""), /[\x00-\x1f\x7f-\x9f]/);
	}
	assert.match(formatModeTopBorder("build", 40, "╮", theme, "Visible title"), /ᴠɪꜱɪʙʟᴇ ᴛɪᴛʟᴇ/);
	assert.doesNotMatch(formatModeTopBorder("build", 40, "╮", theme), /Untitled/);
});

test("composer outline uses only solid lines and rounded corners", () => {
	const theme = { bold: (s: string) => s, fg: (_: string, s: string) => s };
	for (const mode of ["plan", "build"] as const) for (const title of [undefined, "Task title"]) {
		const top = formatModeTopBorder(mode, 40, "╮", theme, title);
		const output = renderModeComposer(["top", "  input", "─".repeat(40)], top, "│ ", "│", "metadata", "╰", 2, 40, { truncate: (s, w) => truncateToWidth(s, w, ""), measure: visibleWidth });
		assert.doesNotMatch(output.join("\n"), /[╌┆┇]/);
		assert.ok(top.endsWith("─╮"));
		assert.ok(output[1].endsWith("│"));
		assert.ok(output.every((line) => visibleWidth(line) <= 40));
	}
});

test("plan title uses normal-weight accent independent of mode border colors", () => {
	for (const mode of ["plan", "build"] as const) {
		const calls: Array<{ color: string; text: string }> = [];
		const theme = { bold: (_: string): string => { throw new Error("Title must not be bold"); }, fg: (color: string, text: string) => { calls.push({ color, text }); return text; } };
		formatModeTopBorder(mode, 60, "╮", theme, "Fix login");
		assert.deepEqual(calls.filter((call) => call.color === "accent"), [{ color: "accent", text: " ꜰɪx ʟᴏɢɪɴ " }]);
		assert.equal(calls[0].color, mode === "plan" ? "warning" : "thinkingLow");
		assert.equal(calls.at(-1)?.color, calls[0].color);
	}
});

test("saved plan headings supply only a safe display fallback for unfinished tasks", () => {
	const markdown = "```md\n# Ignore\n```\n~~~\n# Ignore too\n~~~\n## Not top-level\n# Fix login ###\n# Later title";
	assert.equal(extractPlanTitle(markdown), "Fix login");
	assert.equal(extractPlanTitle("# \n## Only a subheading"), undefined);
	assert.equal(extractPlanTitle("# \x1b[31mSafe\x07 title"), "Safe title");
	const open = { sequence: 1, status: "open" } as const;
	assert.equal(displayedPlanTitle(open, false), undefined);
	assert.equal(displayedPlanTitle(open, true), "Untitled task");
	assert.equal(displayedPlanTitle(open, true, "Saved title"), "Saved title");
	assert.equal(displayedPlanTitle({ ...open, task: { title: "Metadata", scope: "Scope", decisions: [] } }, true, "Saved title"), "Metadata");
	assert.equal(displayedPlanTitle({ ...open, status: "completed" }, true, "Saved title"), undefined);
	assert.equal(displayedPlanTitle({ ...open, status: "abandoned", abandonReason: "No longer needed" }, true, "Saved title"), undefined);
});

test("plan collection decoder rejects dangling attachments and preserves inert detached records", () => {
	const records = [{ plan: { sequence: 1, status: "open" } }, { plan: { sequence: 2, status: "completed" } }, { plan: { sequence: 3, status: "abandoned", abandonReason: "Superseded" } }];
	assert.deepEqual(decodePlanCollection({ records, attached: null, counter: 0 }), { records, attached: null, counter: 3 });
	assert.deepEqual(decodePlanLifecycle({ sequence: 3, status: "abandoned", abandonReason: " Superseded ", outcome: { kind: "blocked", reason: "old" } }), { sequence: 3, status: "abandoned", abandonReason: "Superseded" });
	assert.equal(decodePlanLifecycle({ sequence: 3, status: "abandoned" }), undefined);
	assert.equal(decodePlanCollection({ records, attached: 99, counter: 2 }), undefined);
	assert.equal(decodePlanCollection({ records, attached: 2, counter: 2 }), undefined);
	assert.equal(decodePlanCollection({ records: [records[0], records[0]], attached: 1, counter: 2 }), undefined);
	assert.equal(decodePlanCollection({ records, attached: null, counter: -1 }), undefined);
});

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
		bold(text: string) {
			return `\x1b[1m${text}\x1b[22m`;
		},
		fg(color: "dim" | "warning" | "thinkingLow", text: string) {
			const rgb = {
				dim: "128;128;128",
				warning: "245;167;66",
				thinkingLow: "92;156;245",
			}[color];
			return `\x1b[38;2;${rgb}m${text}\x1b[39m`;
		},
	};
	const thinkingColor = (text: string) => `\x1b[38;2;0;255;0m${text}\x1b[39m`;
	const planRail = formatModeRail("plan", theme);
	const buildRail = formatModeRail("build", theme);
	assert.equal(planRail, "\x1b[38;2;245;167;66m│\x1b[39m");
	assert.equal(buildRail, "\x1b[38;2;92;156;245m│\x1b[39m");
	assert.equal(formatModeRail("plan", theme, "┆"), "\x1b[38;2;245;167;66m┆\x1b[39m");
	assert.equal(formatModeRail("build", theme, "┇"), "\x1b[38;2;92;156;245m┇\x1b[39m");
	assert.equal(formatModeRail("plan", theme, "┃"), "\x1b[38;2;245;167;66m┃\x1b[39m");
	assert.equal(formatModeRail("build", theme, "┃"), "\x1b[38;2;92;156;245m┃\x1b[39m");
	assert.equal(
		formatModeTopBorder("plan", 4, "\x1b[2m╮\x1b[22m", theme),
		"\x1b[38;2;245;167;66m╭──\x1b[39m\x1b[2m╮\x1b[22m",
	);
	assert.equal(formatModeTopBorder("build", 2, "\x1b[2m╮\x1b[22m", theme), "");
	assert.equal(
		formatModeMetadata("plan", "high", theme, thinkingColor),
		"\x1b[38;2;245;167;66m│\x1b[39m \x1b[38;2;245;167;66m\x1b[1mplan\x1b[22m\x1b[39m\x1b[38;2;128;128;128m · \x1b[39m\x1b[38;2;0;255;0mhigh\x1b[39m",
	);
	assert.equal(
		formatModeMetadata("build", "medium", theme, thinkingColor, {
			modelName: "gpt-5.6-sol",
			modelProvider: "openai",
			rail: formatModeRail("build", theme, "┇"),
		}),
		"\x1b[38;2;92;156;245m┇\x1b[39m \x1b[38;2;92;156;245m\x1b[1mbuild\x1b[22m\x1b[39m\x1b[38;2;128;128;128m · \x1b[39mgpt-5.6-sol\x1b[38;2;128;128;128m [openai]\x1b[39m\x1b[38;2;128;128;128m · \x1b[39m\x1b[38;2;0;255;0mmedium\x1b[39m",
	);
});

test("optional UI ownership detects both extension load orders", () => {
	const planBuildEditor = {};
	const otherEditor = {};
	assert.equal(shouldReduceOptionalUi(undefined, undefined), false);
	assert.equal(shouldReduceOptionalUi(otherEditor, undefined), true);
	assert.equal(shouldReduceOptionalUi(planBuildEditor, planBuildEditor), false);
	assert.equal(shouldReduceOptionalUi(otherEditor, planBuildEditor), true);
	assert.equal(shouldReduceOptionalUi(undefined, planBuildEditor), true);
	assert.equal(ownsUiSlot(planBuildEditor, planBuildEditor), true);
	assert.equal(ownsUiSlot(otherEditor, planBuildEditor), false);
	assert.equal(ownsUiSlot(undefined, planBuildEditor), false);
});

test("mode composer preserves input, solid right rails, and width-safe bottom metadata", () => {
	const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
	const lineWidth = {
		truncate: (line: string, width: number) => line.replace(ansiPattern, "").length <= width ? line : line.slice(0, width),
		measure: (line: string) => line.replace(ansiPattern, "").length,
	};
	const lines = ["top border", "  first", "  second", "────────────────", "  autocomplete"];
	assert.deepEqual(renderModeComposer(lines, "╭─────────────╌╮", "│ ", "│", "plan · high", "╰", 2, 16, lineWidth), [
		"╭─────────────╌╮",
		"│              │",
		"│ first        │",
		"│ second       │",
		"│              │",
		"╰ plan · high ─╯",
		"",
		"  autocomplete",
	]);

	const styledGlyph = "\x1b[38;2;157;124;216m─\x1b[39m";
	const realisticLines = ["top", "  prompt", styledGlyph.repeat(16)];
	const realisticResult = renderModeComposer(
		realisticLines,
		"╭─────────────╌╮",
		"│ ",
		"│",
		"metadata",
		"╰",
		2,
		16,
		lineWidth,
	);
	assert.equal(realisticResult.every((line) => lineWidth.measure(line) <= 16), true);
	assert.equal(realisticResult[4]?.replace(ansiPattern, ""), "╰ metadata ────╯");
	assert.equal(realisticResult[4]?.replace(ansiPattern, "").includes("[39m"), false);

	assert.deepEqual(
		renderModeComposer(
			["top", "  prompt", "\x1b[38;2;128;128;128m────\x1b[0m"],
			"╭─╌╮",
			"│ ",
			"│",
			"metadata",
			"╰",
			2,
			4,
			lineWidth,
		).map((line) => line.replace(ansiPattern, "")),
		["╭─╌╮", "│  │", "│ p│", "│  │", "╰ …╯", ""],
	);
	assert.deepEqual(renderModeComposer(lines, "top", "│ ", "│", "metadata", "╰", 0, 16, lineWidth), lines);
});

test("bottom-border metadata keeps colors and fits Unicode widths in both modes", () => {
	const theme = { bold: (text: string) => text, fg: (_: string, text: string) => `\x1b[33m${text}\x1b[0m` };
	const color = (text: string) => `\x1b[32m${text}\x1b[0m`;
	const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
	for (const mode of ["plan", "build"] as const) for (const width of [4, 12, 80]) {
		const metadata = formatModeMetadata(mode, "low", theme, color, { modelName: "模型 🔑", modelProvider: "provider", rail: "" });
		const output = renderModeComposer(["top", "  first", "  second", "─".repeat(width), "suggestion"], "top", "│ ", "│", metadata, "╰", 2, width, { truncate: (text, w) => truncateToWidth(text, w, ""), measure: visibleWidth }, color);
		const bottom = output[5];
		assert.ok(output.slice(0, 6).every((line) => visibleWidth(line) <= width));
		assert.ok(strip(bottom).startsWith("╰"));
		assert.ok(strip(bottom).endsWith("╯"));
		assert.equal(output.at(-1), "suggestion");
		if (width === 80) {
			assert.ok(bottom.includes("\x1b[33m"));
			assert.ok(bottom.includes("\x1b[32m"));
			assert.ok(strip(bottom).includes(`${mode} · 模型 🔑 [provider] · low`));
			assert.equal(output.filter((line) => strip(line).includes("provider")).length, 1);
		}
	}
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
		"I’ll stay in Plan mode and wait for your next instruction.",
	);
});

test("every plan action has a single-line next-action announcement", () => {
	assert.deepEqual(Object.keys(PLAN_ACTION_ANNOUNCEMENTS).sort(), ["implement-fresh", "implement-here", "stay", "step-by-step"]);
	for (const message of Object.values(PLAN_ACTION_ANNOUNCEMENTS)) {
		assert.ok(message.startsWith("I’ll "));
		assert.equal(/[\r\n]/.test(message), false);
	}
	assert.match(PLAN_ACTION_ANNOUNCEMENTS["step-by-step"], /wait for your instruction before starting a step/);
});

test("step-by-step startup guidance points to the panel instructions", () => {
	assert.equal(PLAN_STEP_READY_ACKNOWLEDGEMENT, "Write “Proceed” to start the first step. Instructions are shown at the bottom of the plan panel.");
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
	assert.equal(declined.content[0].text, "Remaining in Plan mode.");

	const cancelled = buildPlanExitStayResult("/tmp/plan.md", true);
	assert.equal(cancelled.terminate, true);
	assert.equal(cancelled.details.cancelled, true);
});

test("plan exit normalizes Escape to the explicit Stay choice", () => {
	assert.deepEqual(normalizePlanExitChoice(undefined), {
		choice: PLAN_EXIT_STAY_CHOICE,
		cancelled: true,
	});
	assert.deepEqual(normalizePlanExitChoice(PLAN_EXIT_STAY_CHOICE), {
		choice: PLAN_EXIT_STAY_CHOICE,
		cancelled: false,
	});
});

test("plan exit classifies all three choices and fails safe", () => {
	assert.equal(classifyPlanExitChoice(PLAN_EXIT_APPROVE_CHOICE), "implement-here");
	assert.equal(classifyPlanExitChoice(PLAN_EXIT_FRESH_CHOICE), "implement-fresh");
	assert.equal(classifyPlanExitChoice(PLAN_EXIT_STAY_CHOICE), "stay");
	assert.equal(classifyPlanExitChoice("unexpected value"), "stay");
});

test("fresh implementation captures the selected model and thinking level", () => {
	assert.deepEqual(
		buildFreshImplementationRequest("plan", { provider: "openai", id: "gpt-5.6" }, "high"),
		{
			plan: "plan",
			model: { provider: "openai", id: "gpt-5.6" },
			thinkingLevel: "high",
		},
	);
	assert.deepEqual(buildFreshImplementationRequest("plan", undefined, "off"), {
		plan: "plan",
		model: undefined,
		thinkingLevel: "off",
	});
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
	assert.equal(result.content[0].text, "Fresh-session implementation selected.");
	const plan = "first line\nlast line";
	const handoff = buildFreshImplementationHandoff(plan);
	assert.match(handoff, /Full tool access is restored/);
	assert.equal(handoff.endsWith(plan), true);
});

test("plan guidance supports conversation before persisted finalization", () => {
	const reminder = buildPlanReminder("No plan file exists yet. Create it only when finalizing.");
	assert.match(reminder, /Plan mode does not require every response to be a final plan/);
	assert.match(reminder, /answer normally without writing Markdown or calling plan_exit/);
	assert.match(reminder, /continue discussion normally until ready/);
	assert.match(reminder, /explicitly asked to finalize/);
	assert.match(reminder, /write the complete plan at its returned canonical path, and call plan_exit/);
	assert.match(reminder, /brief `## Verification` section/);
	assert.match(reminder, /standalone bold labels without colons/i);
	assert.match(reminder, /`\*\*Agent\*\*`/);
	assert.match(reminder, /execution remains deferred until approval/);
	assert.match(reminder, /repository-supported commands with expected observable results/);
	assert.match(reminder, /Never invent commands/i);
	assert.match(reminder, /disclose missing behavioral verification rather than treating build\/type-check as equivalent/);
	assert.match(reminder, /`\*\*User\*\*` only for essential checks/);
	assert.match(reminder, /must not perform these unless separately requested/);
	assert.doesNotMatch(reminder, /`### (?:Agent|User)`|\*\*(?:Agent|User):\*\*/);
	assert.match(PLAN_EXIT_DESCRIPTION, /after finalizing it and resolving planning questions/);
	assert.match(reminder, /## Implementation Steps/);
	assert.match(reminder, /numbered items \(`1\. \.\.\.`, `2\. \.\.\.`\)/);
	assert.match(reminder, /no checkboxes or completion markers/);
	assert.match(reminder, /Record completion only through extension-managed step\/plan tools/);
	assert.equal(reminder.includes("- [ ]"), false);
});

test("verification policy reaches planning and every implementation handoff", () => {
	const prompts = [
		buildPlanReminder("Plan path: /tmp/plan.md"),
		buildPlanContext("build", { records: [{ plan: { sequence: 1, status: "open" } }], attached: 1, counter: 1 }, { path: "/tmp/plan.md", state: "saved" })!,
		buildFreshImplementationHandoff("Approved plan"),
		buildPlanStepReminder("/tmp/plan.md", 1, 2, "Update behavior"),
	];
	for (const prompt of prompts) {
		assert.equal(prompt.split(VERIFICATION_GUIDANCE).length, 2);
	}
	assert.match(VERIFICATION_GUIDANCE, /Use the smallest sufficient verification, then stop/);
	assert.match(VERIFICATION_GUIDANCE, /Default to one focused check/);
	assert.match(VERIFICATION_GUIDANCE, /Scope by behavior and risk, not command count/);
	assert.match(VERIFICATION_GUIDANCE, /Add or update a small test in existing infrastructure/);
	assert.match(VERIFICATION_GUIDANCE, /not as automatic extras/);
	assert.match(VERIFICATION_GUIDANCE, /For prose-only changes, focused inspection is sufficient/);
	assert.match(VERIFICATION_GUIDANCE, /Add checks only for a concrete uncovered behavior or risk, an observed failure, or an explicit user\/repository requirement/);
	assert.match(VERIFICATION_GUIDANCE, /Briefly explain why each additional check is necessary/);
	assert.match(VERIFICATION_GUIDANCE, /use the approved Verification section as the scope/);
	assert.match(VERIFICATION_GUIDANCE, /Once sufficient required checks pass, stop/);
	assert.match(VERIFICATION_GUIDANCE, /Reuse passing results unless subsequent changes could invalidate them/);
	assert.match(VERIFICATION_GUIDANCE, /Do not repeat plan-wide verification after every implementation step/);
	assert.match(VERIFICATION_GUIDANCE, /Report what passed and what remains unverified, including blocked checks/);
	assert.match(VERIFICATION_GUIDANCE, /Never claim unperformed checks passed, weaken checks to obtain a pass, or fix unrelated failures/);
});

test("step execution prompts constrain work to an approved active step", () => {
	const reminder = buildPlanStepReminder("/tmp/plan.md", 2, 4, "Build the parser");
	assert.match(reminder, /only step 2 of 4/);
	assert.match(reminder, /Build the parser/);
	assert.match(reminder, /Do not begin any later plan step/);
	assert.match(reminder, /plan_step_complete/);
	assert.match(reminder, /Validate only the active step as needed/);
	assert.match(reminder, /Defer checks that depend on later steps/);
	assert.match(reminder, /explicitly report those deferrals, not a passing result/);
	assert.match(PLAN_STEP_COMPLETE_DESCRIPTION, /completing its applicable verification/);
	assert.match(PLAN_STEP_COMPLETE_DESCRIPTION, /report checks deferred to later steps without claiming they passed/);
	const waiting = buildPlanStepWaitingReminder("1. [ready] Build parser");
	assert.match(waiting, /No plan step is currently approved/);
	assert.match(waiting, /Do not modify the project/);
	assert.match(waiting, /Interpret intent contextually/);
	assert.match(waiting, /already finished may use complete instead/);
	assert.match(waiting, /When running \(not paused\).*plan_step_control start/);
	assert.match(waiting, /records past work, not permission to implement/);
	assert.match(waiting, /Cancellation remains available/);
	assert.match(waiting, /sidebar is passive and cannot receive input/);
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
