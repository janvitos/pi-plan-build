import assert from "node:assert/strict";
import test from "node:test";
import {
	acceptPlanStep,
	completePlanStep,
	createPlanExecution,
	decodePlanExecution,
	pausePlanExecution,
	requestPlanStepCorrections,
	revisePlanStep,
	skipPlanStep,
	startPlanStep,
	submitPlanStepForReview,
	updatePlanChecklistStep,
} from "./plan-execution.ts";

const plan = `# Plan

Context.

## Implementation Steps

- [ ] Add parser
- [ ] Build panel
- [ ] Verify workflow

## Notes
- [ ] This is not an implementation step
`;

test("parses only the dedicated top-level implementation checklist", () => {
	const state = createPlanExecution(plan);
	assert.deepEqual(state.steps.map((step) => [step.id, step.text, step.status]), [
		["step-1", "Add parser", "ready"],
		["step-2", "Build panel", "pending"],
		["step-3", "Verify workflow", "pending"],
	]);
	assert.equal(state.steps[0]?.sourceLine, 6);
});

test("rejects missing, empty, and duplicate implementation lists", () => {
	assert.throws(() => createPlanExecution("# Plan\n- [ ] loose"), /Implementation Steps/);
	assert.throws(() => createPlanExecution("## Implementation Steps\ntext"), /no top-level/);
	assert.throws(() => createPlanExecution("## Implementation Steps\n- [ ] Same\n- [ ] same"), /Duplicate/);
});

test("gates every step before implementation and after completion", () => {
	let state = createPlanExecution(plan);
	state = startPlanStep(state, "step-1");
	assert.equal(state.steps[0]?.status, "active");
	assert.throws(() => startPlanStep(state, "step-2"), /ready/);
	state = submitPlanStepForReview(state, "step-1", "Parser added and tested");
	assert.equal(state.steps[0]?.status, "review");
	state = requestPlanStepCorrections(state, "step-1");
	assert.equal(state.steps[0]?.status, "active");
	state = submitPlanStepForReview(state, "step-1", "Corrections complete");
	state = acceptPlanStep(state, "step-1");
	assert.equal(state.steps[0]?.status, "completed");
	assert.equal(state.steps[1]?.status, "ready");
	state = skipPlanStep(state, "step-2");
	assert.equal(state.steps[2]?.status, "ready");
	state = startPlanStep(state, "step-3");
	state = submitPlanStepForReview(state, "step-3", "Verified");
	state = acceptPlanStep(state, "step-3");
	assert.equal(state.status, "completed");
});

test("allows clear manual completion of ready steps but preserves transition guards", () => {
	let state = createPlanExecution(plan);
	state = completePlanStep(state, "step-1");
	assert.equal(state.steps[0]?.status, "completed");
	assert.equal(state.steps[1]?.status, "ready");
	assert.throws(() => completePlanStep(state, "step-1"), /ready or reviewed/);
	state = startPlanStep(state, "step-2");
	assert.throws(() => completePlanStep(state, "step-2"), /ready or reviewed/);
});

test("edits only unimplemented steps and updates the canonical checklist safely", () => {
	let state = createPlanExecution(plan);
	state = revisePlanStep(state, "step-1", "Add strict parser");
	assert.equal(state.steps[0]?.text, "Add strict parser");
	const updated = updatePlanChecklistStep(plan, state.steps[0]!.sourceLine, state.steps[0]!.text);
	assert.match(updated, /- \[ \] Add strict parser/);
	assert.throws(() => updatePlanChecklistStep(plan, 0, "unsafe"), /changed/);
	state = startPlanStep(state, "step-1");
	assert.throws(() => revisePlanStep(state, "step-1", "too late"), /unimplemented/);
});

test("pause toggles without losing state and persisted state decodes defensively", () => {
	const state = createPlanExecution(plan);
	const paused = pausePlanExecution(state);
	assert.equal(paused.status, "paused");
	assert.equal(pausePlanExecution(paused).status, "running");
	assert.deepEqual(decodePlanExecution(JSON.parse(JSON.stringify(paused))), paused);
	assert.equal(decodePlanExecution({ version: 1, status: "running", steps: [] }), undefined);
});
