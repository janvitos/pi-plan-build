import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { completePlanStep, createPlanExecution, startPlanStep } from "./plan-execution.ts";
import { PlanPanel } from "./plan-panel.ts";

const theme = {
	fg(_color: string, text: string) { return text; },
	bold(text: string) { return text; },
} as any;

const makeState = () => createPlanExecution("## Implementation Steps\n1. First detailed implementation step\n2. Second step");
const panelText = (lines: string[]) => lines
	.filter((line) => line.startsWith("│"))
	.map((line) => line.slice(2, -2).trim())
	.filter(Boolean)
	.join(" ");

test("passive panel renders steps within its reserved width with fixed instructions", () => {
	const panel = new PlanPanel(makeState(), theme);
	assert.equal("handleInput" in panel, false);
	assert.equal("focused" in panel, false);
	const lines = panel.render(72);
	assert.equal(lines.every((line) => visibleWidth(line) <= 72), true);
	const output = lines.join("\n");
	assert.match(output, /Plan 0\/2/);
	assert.doesNotMatch(panelText(lines), /Tell the agent|You can also/);
	assert.doesNotMatch(output, />▷|>>/);
	const firstStepIndex = lines.findIndex((line) => line.includes("1. First detailed implementation step"));
	assert.ok(firstStepIndex >= 0);
	assert.match(lines[firstStepIndex + 1]!, /^│\s+│$/);
	assert.match(lines[firstStepIndex + 2]!, /2\. Second step/);
	for (const line of lines.filter((candidate) => candidate.startsWith("│"))) {
		assert.equal(line[1], " ", "content rows have one column of left padding");
		assert.equal(line.at(-2), " ", "content rows have one column of right padding");
	}
});

test("keeps complete instructions in the last cell across states and step transitions", () => {
	const expected = [
		"How to use",
		"Write your instructions in the chat.",
		"- Write “Proceed” to start the next step.",
		"- Ask to edit, skip, or mark a step complete.",
		"- Ask to pause, resume, or cancel the plan.",
		"- Ask to hide or show this panel.",
		"You can use your own words.",
	].join(" ");
	const ready = makeState();
	const active = startPlanStep(ready, "step-1");
	const nextReady = completePlanStep(active, "step-1");
	const completed = completePlanStep(nextReady, "step-2", "Unique completion summary");
	const states = [ready, active, nextReady, { ...active, status: "paused" as const }, completed, { ...ready, selectedStepId: undefined }];
	const panel = new PlanPanel(ready, theme);
	for (const width of [40, 72]) {
		for (const state of states) {
			panel.setState(state);
			const lines = panel.render(width);
			assert.equal(lines.every(line => visibleWidth(line) <= width), true);
			assert.match(lines.at(-1)!, /^╰─+╯$/);
			assert.ok(lines.at(-2)!.startsWith("│"));
			assert.ok(lines.at(-2)!.slice(2, -2).trim(), "content ends directly above the bottom border");
			assert.equal(lines.filter(line => line.startsWith("├")).length, 2);
			const lastSeparator = lines.findLastIndex(line => line.startsWith("├"));
			assert.equal(panelText(lines.slice(lastSeparator + 1)), expected);
			assert.equal(panelText(lines).split("First detailed implementation step").length - 1, 1);
			assert.equal(panelText(lines).split("Second step").length - 1, 1);
			assert.doesNotMatch(panelText(lines), /Result:|Unique completion summary/);
			const glyphs = { pending: "○", ready: "▷", active: "▶", completed: "✓", skipped: "–" };
			for (const [index, step] of state.steps.entries()) {
				assert.ok(panelText(lines).includes(`${glyphs[step.status]} ${index + 1}.`));
			}
			assert.doesNotMatch(panelText(lines), /Tell the agent|Use the composer|You can also|Plan complete/);
			assert.match(lines[2]!, new RegExp(state.status === "completed" ? "complete" : state.status));
			assert.match(panelText(lines), /First detailed implementation step/);
		}
	}
});

test("wraps long step instructions instead of truncating them", () => {
	const text = "This deliberately long step instruction must wrap across multiple panel rows without losing its final words.";
	const panel = new PlanPanel(createPlanExecution(`## Implementation Steps\n1. ${text}`), theme);
	const output = panel.render(40).join("\n");
	assert.match(output, /This deliberately long step/);
	assert.match(output, /losing its final words\./);
	assert.equal(output.includes("…"), false);
});

test("passive panel reflects direct completion without review controls", () => {
	const initial = makeState();
	const completed = completePlanStep(startPlanStep(initial, "step-1"), "step-1", "Created and verified the parser");
	const panel = new PlanPanel(completed, theme);
	const lines = panel.render(72);
	const output = lines.join("\n");
	assert.match(output, /1\. First detailed implementation step/);
	assert.match(output, /Plan 1\/2/);
	assert.doesNotMatch(panelText(lines), /Tell the agent|You can also/);
	assert.doesNotMatch(output, /accept|correct|review/);
});
