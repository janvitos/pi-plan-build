import assert from "node:assert/strict";
import test from "node:test";
import {
	activePlanStep,
	executablePlanStep,
	completePlanStep,
	createPlanExecution,
	decodePlanExecution,
	formatPlanCompletionSummary,
	formatPlanClosureSummary,
	pausePlanExecution,
	revisePlanStep,
	parseImplementationSteps,
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
	assert.equal(Object.hasOwn(state, "selectedStepId"), false);
	assert.equal(Object.hasOwn(startPlanStep(state, "step-1"), "selectedStepId"), false);
	assert.equal(Object.hasOwn(completePlanStep(state, "step-1"), "selectedStepId"), false);
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

test("formats bounded factual progress when a user closes an incomplete execution", () => {
	let state = createPlanExecution(plan);
	state = completePlanStep(state, "step-1", "Parser added and tested");
	state = startPlanStep(state, "step-2");
	const summary = formatPlanClosureSummary(state, "User ended the remaining work.");
	assert.match(summary, /^Closed by explicit user instruction/);
	assert.match(summary, /\n\nUser ended the remaining work\.$/);
	assert.match(summary, /1 completed, 0 skipped, 1 active, 0 ready, 1 pending/);
	assert.match(summary, /1\. \[completed\] Add parser — Parser added and tested/);
	assert.match(summary, /2\. \[active\] Build panel/);
	assert.doesNotMatch(summary, /3\. \[completed\]/);
	const oversized = createPlanExecution(`## Implementation Steps\n1. ${"Long instruction ".repeat(400)}`);
	const bounded = formatPlanClosureSummary(oversized, "User summary");
	assert.ok(bounded.length <= 4000);
	assert.match(bounded, /^Closed by explicit user instruction/);
	assert.match(bounded, /0 completed, 0 skipped, 0 active, 1 ready, 0 pending/);
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

test("revisions reject duplicate or inconsistent instructions and keep snapshots coherent", () => {
	const state = createPlanExecution(plan);
	const before = structuredClone(state);
	assert.throws(() => revisePlanStep(state, "step-1", state.steps[1].text.toUpperCase()), /Duplicate/);
	assert.throws(() => revisePlanStep(state, "step-1", "New", plan.replace("Add parser", "Different")), /changed/);
	assert.deepEqual(state, before);
	const revised = revisePlanStep(state, "step-1", "New");
	assert.equal(revised.planMarkdown, plan.replace("Add parser", "New"));
	assert.deepEqual(parseImplementationSteps(revised.planMarkdown).map(s => s.text), revised.steps.map(s => s.text));
	const mixed = "# Plan\r\n## Implementation Steps\n1. Original  \r2. Other\r\n";
	assert.equal(updatePlanStepInstruction(mixed, 2, "Revised", "Original"), mixed.replace("Original", "Revised"));
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

test("fenced examples do not supply headings, steps, duplicates, or section boundaries", () => {
	for (const fence of ["```", "~~~~"]) {
		const source = `${fence}markdown\n# Example\n## Implementation Steps\n1. Fake\n${fence}\n# Real\n## Implementation Steps\n1. Real\n${fence}\n## Notes\n2. Real\n${fence}\n2. Next\n`;
		assert.deepEqual(createPlanExecution(source).steps.map((step) => step.text), ["Real", "Next"]);
	}
});

test("paused active steps retain progress without executable authority", () => {
	const active = startPlanStep(createPlanExecution(plan), "step-1");
	const paused = pausePlanExecution(active);
	assert.equal(activePlanStep(paused)?.id, "step-1");
	assert.equal(executablePlanStep(paused), undefined);
	assert.equal(executablePlanStep(pausePlanExecution(paused))?.id, "step-1");
	assert.throws(() => startPlanStep(pausePlanExecution(createPlanExecution(plan)), "step-1"), /Resume/);
	const recorded = completePlanStep(pausePlanExecution(createPlanExecution(plan)), "step-1");
	assert.equal(recorded.status, "paused", "recording already-done work does not resume implementation");
	assert.equal(executablePlanStep(recorded), undefined);
});

test("revisions compare expected content and preserve whitespace", () => {
	const source = "## Implementation Steps\r\n1. Original  \r\n2. Other\r\n";
	assert.equal(updatePlanStepInstruction(source, 1, "Revised", "Original"), source.replace("Original", "Revised"));
	assert.throws(() => updatePlanStepInstruction(source, 2, "Wrong", "Original"), /changed/);
	assert.throws(() => updatePlanStepInstruction(source, 1, "new\n2. injected", "Original"), /single-line/);
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
