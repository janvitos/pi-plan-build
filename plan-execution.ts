export type PlanStepStatus = "pending" | "ready" | "active" | "review" | "completed" | "skipped";

export interface PlanStep {
	id: string;
	text: string;
	status: PlanStepStatus;
	sourceLine: number;
	summary?: string;
}

export interface PlanExecutionState {
	version: 1;
	status: "running" | "paused" | "completed";
	steps: PlanStep[];
	planMarkdown: string;
	selectedStepId?: string;
	panelVisible: boolean;
}

const IMPLEMENTATION_HEADING = /^##\s+Implementation Steps\s*$/i;
const NEXT_H2 = /^##\s+/;
const CHECKLIST_ITEM = /^- \[ \]\s+(.+?)\s*$/;

export function parseImplementationSteps(plan: string): PlanStep[] {
	const lines = plan.replace(/\r\n?/g, "\n").split("\n");
	const heading = lines.findIndex((line) => IMPLEMENTATION_HEADING.test(line.trim()));
	if (heading < 0) throw new Error("The plan needs a ‘## Implementation Steps’ section");

	const steps: PlanStep[] = [];
	const seen = new Set<string>();
	for (let index = heading + 1; index < lines.length; index++) {
		const line = lines[index]!;
		if (NEXT_H2.test(line.trim())) break;
		const match = CHECKLIST_ITEM.exec(line);
		if (!match) continue;
		const text = match[1]!.trim();
		const normalized = text.toLocaleLowerCase();
		if (!text) throw new Error(`Implementation step on line ${index + 1} is empty`);
		if (seen.has(normalized)) throw new Error(`Duplicate implementation step: ${text}`);
		seen.add(normalized);
		steps.push({ id: `step-${steps.length + 1}`, text, status: "pending", sourceLine: index });
	}
	if (steps.length === 0) throw new Error("The Implementation Steps section has no top-level ‘- [ ]’ items");
	return steps;
}

export function createPlanExecution(plan: string): PlanExecutionState {
	const steps = parseImplementationSteps(plan);
	steps[0]!.status = "ready";
	return { version: 1, status: "running", steps, planMarkdown: plan, selectedStepId: steps[0]!.id, panelVisible: true };
}

export function decodePlanExecution(value: unknown): PlanExecutionState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<PlanExecutionState>;
	if (candidate.version !== 1 || !["running", "paused", "completed"].includes(candidate.status ?? "")) return undefined;
	if (!Array.isArray(candidate.steps) || candidate.steps.length === 0 || typeof candidate.planMarkdown !== "string") return undefined;
	const validStatuses = new Set<PlanStepStatus>(["pending", "ready", "active", "review", "completed", "skipped"]);
	const steps: PlanStep[] = [];
	for (const raw of candidate.steps) {
		if (!raw || typeof raw !== "object") return undefined;
		const step = raw as Partial<PlanStep>;
		if (typeof step.id !== "string" || typeof step.text !== "string" || !validStatuses.has(step.status as PlanStepStatus)) return undefined;
		if (!Number.isInteger(step.sourceLine) || (step.sourceLine ?? -1) < 0) return undefined;
		steps.push({ id: step.id, text: step.text, status: step.status as PlanStepStatus, sourceLine: step.sourceLine!, ...(typeof step.summary === "string" ? { summary: step.summary } : {}) });
	}
	return {
		version: 1,
		status: candidate.status!,
		steps,
		planMarkdown: candidate.planMarkdown,
		selectedStepId: typeof candidate.selectedStepId === "string" ? candidate.selectedStepId : undefined,
		panelVisible: candidate.panelVisible !== false,
	};
}

function clone(state: PlanExecutionState): PlanExecutionState {
	return { ...state, steps: state.steps.map((step) => ({ ...step })) };
}

function findStep(state: PlanExecutionState, id: string): PlanStep {
	const step = state.steps.find((candidate) => candidate.id === id);
	if (!step) throw new Error(`Unknown plan step: ${id}`);
	return step;
}

function makeNextReady(state: PlanExecutionState, afterId: string): void {
	const index = state.steps.findIndex((step) => step.id === afterId);
	const next = state.steps.slice(index + 1).find((step) => step.status === "pending");
	if (next) {
		next.status = "ready";
		state.selectedStepId = next.id;
		return;
	}
	if (state.steps.every((step) => step.status === "completed" || step.status === "skipped")) {
		state.status = "completed";
		state.selectedStepId = undefined;
	}
}

export function startPlanStep(state: PlanExecutionState, id: string): PlanExecutionState {
	const next = clone(state);
	if (next.status === "completed") throw new Error("The plan is already complete");
	const step = findStep(next, id);
	if (step.status !== "ready") throw new Error("Only a ready step can be implemented");
	step.status = "active";
	next.status = "running";
	next.selectedStepId = id;
	return next;
}

export function submitPlanStepForReview(state: PlanExecutionState, id: string, summary: string): PlanExecutionState {
	const next = clone(state);
	const step = findStep(next, id);
	if (step.status !== "active") throw new Error("Only the active step can be submitted for review");
	step.status = "review";
	step.summary = summary.trim();
	next.selectedStepId = id;
	return next;
}

export function completePlanStep(state: PlanExecutionState, id: string): PlanExecutionState {
	const next = clone(state);
	const step = findStep(next, id);
	if (step.status !== "ready" && step.status !== "review") {
		throw new Error("Only a ready or reviewed step can be marked complete");
	}
	step.status = "completed";
	makeNextReady(next, id);
	return next;
}

export function acceptPlanStep(state: PlanExecutionState, id: string): PlanExecutionState {
	const step = findStep(state, id);
	if (step.status !== "review") throw new Error("Only a step awaiting review can be accepted");
	return completePlanStep(state, id);
}

export function requestPlanStepCorrections(state: PlanExecutionState, id: string): PlanExecutionState {
	const next = clone(state);
	const step = findStep(next, id);
	if (step.status !== "review") throw new Error("Only a step awaiting review can receive corrections");
	step.status = "active";
	next.selectedStepId = id;
	return next;
}

export function skipPlanStep(state: PlanExecutionState, id: string): PlanExecutionState {
	const next = clone(state);
	const step = findStep(next, id);
	if (step.status !== "ready") throw new Error("Only a ready step can be skipped");
	step.status = "skipped";
	makeNextReady(next, id);
	return next;
}

export function revisePlanStep(state: PlanExecutionState, id: string, text: string, planMarkdown = state.planMarkdown): PlanExecutionState {
	const revised = text.trim();
	if (!revised) throw new Error("A plan step cannot be empty");
	const next = clone(state);
	const step = findStep(next, id);
	if (step.status !== "pending" && step.status !== "ready") throw new Error("Only an unimplemented step can be edited");
	step.text = revised;
	next.planMarkdown = planMarkdown;
	return next;
}

export function pausePlanExecution(state: PlanExecutionState): PlanExecutionState {
	if (state.status === "completed") return state;
	return { ...clone(state), status: state.status === "paused" ? "running" : "paused" };
}

export function updatePlanChecklistStep(plan: string, sourceLine: number, text: string): string {
	const newline = plan.includes("\r\n") ? "\r\n" : "\n";
	const lines = plan.replace(/\r\n?/g, "\n").split("\n");
	if (!Number.isInteger(sourceLine) || sourceLine < 0 || sourceLine >= lines.length || !CHECKLIST_ITEM.test(lines[sourceLine]!)) {
		throw new Error("The saved plan changed and the selected checklist item can no longer be updated safely");
	}
	lines[sourceLine] = `- [ ] ${text.trim()}`;
	return lines.join(newline);
}

export function activePlanStep(state: PlanExecutionState | undefined): PlanStep | undefined {
	return state?.steps.find((step) => step.status === "active");
}
