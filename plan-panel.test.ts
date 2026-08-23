import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { completePlanStep, createPlanExecution, startPlanStep } from "./plan-execution.ts";
import { PlanPanel } from "./plan-panel.ts";

const theme = {
	fg(_color: string, text: string) { return text; },
	bold(text: string) { return text; },
} as any;

const makeState = () => createPlanExecution("## Implementation Steps\n- [ ] First detailed implementation step\n- [ ] Second step");
const panelText = (lines: string[]) => lines
	.filter((line) => line.startsWith("│"))
	.map((line) => line.slice(2, -2).trim())
	.filter(Boolean)
	.join(" ");

test("passive panel renders within its reserved width and explains prompt control", () => {
	const panel = new PlanPanel(makeState(), theme);
	assert.equal("handleInput" in panel, false);
	assert.equal("focused" in panel, false);
	const lines = panel.render(72);
	assert.equal(lines.every((line) => visibleWidth(line) <= 72), true);
	const output = lines.join("\n");
	assert.match(output, /Plan 0\/2/);
	assert.match(panelText(lines), /Tell the agent to implement, complete, edit, or skip steps\. You can also cancel or hide the plan\./);
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

test("wraps panel guidance instead of truncating it", () => {
	const lines = new PlanPanel(makeState(), theme).render(40);
	const output = lines.join("\n");
	assert.equal(lines.every((line) => visibleWidth(line) <= 40), true);
	assert.match(panelText(lines), /Tell the agent to implement, complete, edit, or skip steps\. You can also cancel or hide the plan\./);
});

test("wraps long step instructions instead of truncating them", () => {
	const text = "This deliberately long step instruction must wrap across multiple panel rows without losing its final words.";
	const panel = new PlanPanel(createPlanExecution(`## Implementation Steps\n- [ ] ${text}`), theme);
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
	assert.match(panelText(lines), /Tell the agent to implement, complete, edit, or skip steps\. You can also cancel or hide the plan\./);
	assert.doesNotMatch(output, /accept|correct|review/);
});
