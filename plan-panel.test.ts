import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPlanExecution, startPlanStep, submitPlanStepForReview } from "./plan-execution.ts";
import { PlanPanel } from "./plan-panel.ts";

const theme = {
	fg(_color: string, text: string) { return text; },
	bold(text: string) { return text; },
} as any;

const makeState = () => createPlanExecution("## Implementation Steps\n- [ ] First detailed implementation step\n- [ ] Second step");

test("passive panel renders within its reserved width and explains prompt control", () => {
	const panel = new PlanPanel(makeState(), theme);
	assert.equal("handleInput" in panel, false);
	assert.equal("focused" in panel, false);
	const lines = panel.render(72);
	assert.equal(lines.every((line) => visibleWidth(line) <= 72), true);
	const output = lines.join("\n");
	assert.match(output, /Plan 0\/2/);
	assert.match(output, /Tell the agent to implement/);
	assert.match(output, /cancel/);
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

test("wraps long step instructions instead of truncating them", () => {
	const text = "This deliberately long step instruction must wrap across multiple panel rows without losing its final words.";
	const panel = new PlanPanel(createPlanExecution(`## Implementation Steps\n- [ ] ${text}`), theme);
	const output = panel.render(40).join("\n");
	assert.match(output, /This deliberately long step/);
	assert.match(output, /losing its final words\./);
	assert.equal(output.includes("…"), false);
});

test("passive panel reflects review state and result summaries", () => {
	const initial = makeState();
	const review = submitPlanStepForReview(startPlanStep(initial, "step-1"), "step-1", "Created and verified the parser");
	const panel = new PlanPanel(review, theme);
	const output = panel.render(72).join("\n");
	assert.match(output, /Created and verified the parser/);
	assert.match(output, /Tell the agent to accept, correct, or cancel the plan/);
});
