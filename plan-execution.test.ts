import assert from "node:assert/strict";
import test from "node:test";
import {
	completePlanStep,
	createPlanExecution,
	decodePlanExecution,
	formatPlanCompletionSummary,
	pausePlanExecution,
	revisePlanStep,
	skipPlanStep,
	startPlanStep,
	updatePlanStepInstruction,
} from "./plan-execution.ts";

const plan = `# Plan

Context.

## Implementation Steps

1. Add parser
2. Build panel
3. Verify workflow

## Notes
- [ ] This is not an implementation step
`;

test("parses only the dedicated top-level numbered implementation steps", () => {
	const state = createPlanExecution(plan);
	assert.deepEqual(state.steps.map((step) => [step.id, step.text, step.status]), [
		["step-1", "Add parser", "ready"],
		["step-2", "Build panel", "pending"],
		["step-3", "Verify workflow", "pending"],
	]);
	assert.equal(state.steps[0]?.sourceLine, 6);
});

test("supports repeated numbering and legacy items in document order, excluding nested and checked items", () => {
	const state = createPlanExecution("## Implementation Steps\n1. First\n   1. Nested\n1. Second\n- [ ] Legacy\n- [x] Finished\n## Notes\n2. Outside");
	assert.deepEqual(state.steps.map(s => [s.id, s.text, s.sourceLine]), [
		["step-1", "First", 1], ["step-2", "Second", 3], ["step-3", "Legacy", 4],
	]);
	const legacy = createPlanExecution("## Implementation Steps\n- [ ] First\n- [ ] Second");
	assert.equal(completePlanStep(legacy, "step-1").steps[1]?.status, "ready");
});

test("rejects missing, empty, and duplicate implementation lists", () => {
	assert.throws(() => createPlanExecution("# Plan\n- [ ] loose"), /Implementation Steps/);
	assert.throws(() => createPlanExecution("## Implementation Steps\ntext"), /no top-level/);
	for (const items of ["1. Same\n2. same", "- [ ] Same\n- [ ] same", "1. Same\n- [ ] same"]) {
		assert.throws(() => createPlanExecution(`## Implementation Steps\n${items}`), /Duplicate/);
	}
});

test("completes active steps directly and gates the next step", () => {
	let state = createPlanExecution(plan);
	state = startPlanStep(state, "step-1");
	assert.equal(state.steps[0]?.status, "active");
	assert.throws(() => startPlanStep(state, "step-2"), /ready/);
	state = completePlanStep(state, "step-1", "Parser added and tested");
	assert.equal(state.steps[0]?.status, "completed");
	assert.equal(state.steps[0]?.summary, "Parser added and tested");
	assert.equal(state.steps[1]?.status, "ready");
	state = skipPlanStep(state, "step-2");
	assert.equal(state.steps[2]?.status, "ready");
	state = startPlanStep(state, "step-3");
	state = completePlanStep(state, "step-3", "Verified");
	assert.equal(state.status, "completed");
});

test("allows clear manual completion of ready steps but preserves transition guards", () => {
	let state = createPlanExecution(plan);
	state = completePlanStep(state, "step-1");
	assert.equal(state.steps[0]?.status, "completed");
	assert.equal(state.steps[1]?.status, "ready");
	assert.throws(() => completePlanStep(state, "step-1"), /ready or active/);
	state = startPlanStep(state, "step-2");
	state = completePlanStep(state, "step-2");
	assert.equal(state.steps[1]?.status, "completed");
	assert.throws(() => completePlanStep(state, "step-2"), /ready or active/);
});

test("formats a completion summary for the main window", () => {
	let state = createPlanExecution(plan);
	state = completePlanStep(state, "step-1", "Parser added and tested");
	state = skipPlanStep(state, "step-2");
	state = completePlanStep(state, "step-3", "Workflow verified");
	const summary = formatPlanCompletionSummary(state);
	assert.match(summary, /^# Plan complete\n\n## Summary\n\n/);
	assert.match(summary, /1\. \*\*Completed:\*\* Add parser\n\n   Parser added and tested/);
	assert.match(summary, /2\. \*\*Skipped:\*\* Build panel/);
	assert.match(summary, /3\. \*\*Completed:\*\* Verify workflow\n\n   Workflow verified/);
});

test("edits only unimplemented steps and updates the canonical numbered instruction safely", () => {
	let state = createPlanExecution(plan);
	state = revisePlanStep(state, "step-1", "Add strict parser");
	assert.equal(state.steps[0]?.text, "Add strict parser");
	const updated = updatePlanStepInstruction(plan, state.steps[0]!.sourceLine, state.steps[0]!.text);
	assert.equal(updated, plan.replace("1. Add parser", "1. Add strict parser"));
	assert.throws(() => updatePlanStepInstruction(plan, 0, "unsafe"), /changed/);
	state = startPlanStep(state, "step-1");
	assert.throws(() => revisePlanStep(state, "step-1", "too late"), /unimplemented/);
});

test("instruction revisions preserve numbered and legacy markers and newline style", () => {
	for (const marker of ["12. ", "1.   ", "- [ ] "]) {
		for (const newline of ["\n", "\r\n"]) {
			const source = `## Implementation Steps${newline}${marker}Original${newline}`;
			assert.equal(updatePlanStepInstruction(source, 1, "Revised"), source.replace("Original", "Revised"));
		}
	}
	assert.throws(() => updatePlanStepInstruction("## Implementation Steps\n- [x] Done", 1, "Changed"), /changed/);
});

test("pause toggles without losing state and persisted state decodes defensively", () => {
	const state = createPlanExecution(plan);
	const paused = pausePlanExecution(state);
	assert.equal(paused.status, "paused");
	assert.equal(pausePlanExecution(paused).status, "running");
	assert.deepEqual(decodePlanExecution(JSON.parse(JSON.stringify(paused))), paused);
	const legacy = { ...paused, selectedStepId: "step-1", steps: paused.steps.map((step, index) => index === 0 ? { ...step, status: "review" } : step) };
	const migrated = decodePlanExecution(legacy);
	assert.equal(migrated?.steps[0]?.status, "completed");
	assert.equal(migrated?.steps[1]?.status, "ready");
	assert.equal(decodePlanExecution({ version: 1, status: "running", steps: [] }), undefined);
});
