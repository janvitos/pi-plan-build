import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getScrollViewsAt, renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { completePlanStep, createPlanExecution, startPlanStep } from "./plan-execution.ts";
import { ContainedScrollView, PlanPanel } from "./plan-panel.ts";

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

test("contained scroller swallows leftover wheel lines so the chat never chains", () => {
	const child = { render: () => ["a", "b", "c"], invalidate: () => {} } as unknown as Component;
	const requestRender = () => {};
	const plain = new ScrollView(child);
	plain.updateLayout(3, 2, requestRender);
	assert.equal(plain.scrollBy(5), 4, "a plain ScrollView reports the unconsumed remainder");
	const contained = new ContainedScrollView(child, { overscroll: "contain" });
	contained.updateLayout(3, 2, requestRender);
	contained.scrollBy(5);
	assert.equal(contained.scrollTop, 1, "the scroller itself still moves and clamps");
	assert.equal(contained.scrollBy(5), 0, "leftover wheel lines are consumed, so routeWheel cannot chain to the primary");
	assert.equal(contained.scrollBy(-5), 0);
});

test("only steps scroll while status and guidance remain fixed", () => {
	const markdown = `## Implementation Steps\n${Array.from({ length: 8 }, (_, index) => `${index + 1}. Implementation step ${index + 1}`).join("\n")}`;
	const panel = new PlanPanel(createPlanExecution(markdown), theme);
	const before = renderLayoutFrame(panel, 64, 14, () => {});
	const scrollers = getScrollViewsAt(before, 10, 5);
	assert.equal(scrollers.length, 1, "the step viewport is the only scroller under its rows");
	assert.equal(getScrollViewsAt(before, 10, 1).length, 0, "the fixed header does not scroll");
	assert.equal(getScrollViewsAt(before, 10, 13).length, 0, "the fixed guidance does not scroll");
	assert.match(before.lines.join("\n"), /1\. Implementation step 1/);
	assert.doesNotMatch(before.lines.join("\n"), /8\. Implementation step 8/);

	scrollers[0]!.scrollBy(100);
	const after = renderLayoutFrame(panel, 64, 14, () => {});
	assert.deepEqual(after.lines.slice(0, 4), before.lines.slice(0, 4), "plan progress and status stay pinned");
	const guidanceStart = before.lines.findLastIndex((line) => line.startsWith("├"));
	assert.deepEqual(after.lines.slice(guidanceStart), before.lines.slice(guidanceStart), "the guidance stays pinned");
	assert.doesNotMatch(after.lines.join("\n"), /1\. Implementation step 1/);
	assert.match(after.lines.join("\n"), /8\. Implementation step 8/);
});

test("passive panel renders steps within its reserved width with concise guidance", () => {
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

test("guidance highlights its heading and action words", () => {
	const bolded: string[] = [];
	const capture = { ...theme, bold(text: string) { bolded.push(text); return text; } };
	new PlanPanel(makeState(), capture).render(64);
	for (const text of ["You can:", "Proceed", "Revise", "skip", "Pause", "stop", "Complete"]) {
		assert.ok(bolded.includes(text), `${text} should be bold`);
	}
	assert.equal(bolded.some((text) => text.includes("next step")), false, "supporting copy remains regular weight");
});

test("keeps complete guidance in the last cell across states and step transitions", () => {
	const expected = [
		"You can:",
		"- Proceed with the next step.",
		"- Revise or skip a step.",
		"- Pause or stop execution.",
		"- Complete the plan at any time.",
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

test("panel statuses use neutral, caution, and success colors consistently", () => {
	const calls: Array<{ color: string; text: string }> = [];
	const capture = { fg(color: string, text: string) { calls.push({ color, text }); return text; }, bold(text: string) { return text; } } as any;
	const panel = new PlanPanel(makeState(), capture);
	panel.render(72);
	assert.ok(calls.some((call) => call.color === "muted" && call.text === "running"));
	calls.length = 0;
	panel.setState({ ...makeState(), status: "paused" });
	panel.render(72);
	assert.ok(calls.some((call) => call.color === "warning" && call.text === "paused"));
	calls.length = 0;
	const completed = completePlanStep(completePlanStep(makeState(), "step-1"), "step-2", "Done");
	panel.setState(completed);
	panel.render(72);
	assert.ok(calls.some((call) => call.color === "success" && call.text === "complete"));
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
