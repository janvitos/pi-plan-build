import { scanPlanMarkdown } from "./plan-markdown.ts";

export type PlanStepStatus = "pending" | "ready" | "active" | "completed" | "skipped";

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
	/** Legacy storage only; current selection is derived from step statuses. */
	selectedStepId?: string;
	panelVisible: boolean;
}

const IMPLEMENTATION_HEADING = /^##\s+Implementation Steps\s*$/i;
const NEXT_H2 = /^##\s+/;
// Capture the marker separately so instruction revisions preserve the source format.
const IMPLEMENTATION_ITEM = /^(\d+\.\s+|- \[ \]\s+)(\S.*?)\s*$/;

export function parseImplementationSteps(plan: string): PlanStep[] {
	const lines = [...scanPlanMarkdown(plan)];
	const heading = lines.findIndex(({ line }) => IMPLEMENTATION_HEADING.test(line.trim()));
	if (heading < 0) throw new Error("The plan needs a ‘## Implementation Steps’ section");

	const steps: PlanStep[] = [];
	const seen = new Set<string>();
	for (const { line, index } of lines.slice(heading + 1)) {
		if (NEXT_H2.test(line.trim())) break;
		const match = IMPLEMENTATION_ITEM.exec(line);
		if (!match) continue;
		const text = match[2]!.trim();
		const normalized = text.toLocaleLowerCase();
		if (!text) throw new Error(`Implementation step on line ${index + 1} is empty`);
		if (seen.has(normalized)) throw new Error(`Duplicate implementation step: ${text}`);
		seen.add(normalized);
		steps.push({ id: `step-${steps.length + 1}`, text, status: "pending", sourceLine: index });
	}
	if (steps.length === 0) throw new Error("The Implementation Steps section has no top-level numbered steps (or legacy unchecked checkbox items)");
	return steps;
}

export function createPlanExecution(plan: string): PlanExecutionState {
	const steps = parseImplementationSteps(plan);
	steps[0]!.status = "ready";
	return { version: 1, status: "running", steps, planMarkdown: plan, panelVisible: true };
}

export function decodePlanExecution(value: unknown): PlanExecutionState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<PlanExecutionState>;
	if (candidate.version !== 1 || !["running", "paused", "completed"].includes(candidate.status ?? "")) return undefined;
	if (!Array.isArray(candidate.steps) || candidate.steps.length === 0 || typeof candidate.planMarkdown !== "string") return undefined;
	const validStatuses = new Set<PlanStepStatus>(["pending", "ready", "active", "completed", "skipped"]);
	const steps: PlanStep[] = [];
	let legacyReviewIndex = -1;
	for (const raw of candidate.steps) {
		if (!raw || typeof raw !== "object") return undefined;
		const step = raw as Partial<PlanStep> & { status?: string };
		const status = step.status === "review" ? "completed" : step.status;
		if (step.status === "review") legacyReviewIndex = steps.length;
		if (typeof step.id !== "string" || typeof step.text !== "string" || !validStatuses.has(status as PlanStepStatus)) return undefined;
		if (!Number.isInteger(step.sourceLine) || (step.sourceLine ?? -1) < 0) return undefined;
		steps.push({ id: step.id, text: step.text, status: status as PlanStepStatus, sourceLine: step.sourceLine!, ...(typeof step.summary === "string" ? { summary: step.summary } : {}) });
	}
	let selectedStepId = typeof candidate.selectedStepId === "string" ? candidate.selectedStepId : undefined;
	let status = candidate.status!;
	if (legacyReviewIndex >= 0) {
		const next = steps.slice(legacyReviewIndex + 1).find((step) => step.status === "pending");
		if (next) {
			next.status = "ready";
			selectedStepId = next.id;
		} else if (steps.every((step) => step.status === "completed" || step.status === "skipped")) {
			status = "completed";
			selectedStepId = undefined;
		}
	}
	return {
		version: 1,
		status,
		steps,
		planMarkdown: candidate.planMarkdown,
		...(selectedStepId !== undefined ? { selectedStepId } : {}),
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
		return;
	}
	if (state.steps.every((step) => step.status === "completed" || step.status === "skipped")) {
		state.status = "completed";
	}
}

export function formatPlanCompletionSummary(state: PlanExecutionState): string {
	const lines = ["# Plan complete", "", "## Summary", ""];
	for (const [index, step] of state.steps.entries()) {
		const outcome = step.status === "skipped" ? "Skipped" : "Completed";
		lines.push(`${index + 1}. **${outcome}:** ${step.text}`);
		if (step.summary?.trim()) lines.push("", `   ${step.summary.trim()}`);
		if (index < state.steps.length - 1) lines.push("");
	}
	return lines.join("\n");
}

export function startPlanStep(state: PlanExecutionState, id: string): PlanExecutionState {
	const next = clone(state);
	if (next.status === "completed") throw new Error("The plan is already complete");
	if (next.status === "paused") throw new Error("Resume plan execution before starting a step");
	const step = findStep(next, id);
	if (step.status !== "ready") throw new Error("Only a ready step can be implemented");
	step.status = "active";
	next.status = "running";
	return next;
}

export function completePlanStep(state: PlanExecutionState, id: string, summary?: string): PlanExecutionState {
	const next = clone(state);
	const step = findStep(next, id);
	if (step.status !== "ready" && step.status !== "active") {
		throw new Error("Only a ready or active step can be marked complete");
	}
	if (summary?.trim()) step.summary = summary.trim();
	step.status = "completed";
	makeNextReady(next, id);
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

export function updatePlanStepInstruction(plan: string, sourceLine: number, text: string, expected?: string): string {
	const newline = plan.includes("\r\n") ? "\r\n" : "\n";
	const lines = plan.replace(/\r\n?/g, "\n").split("\n");
	const match = Number.isInteger(sourceLine) && sourceLine >= 0 && sourceLine < lines.length
		? IMPLEMENTATION_ITEM.exec(lines[sourceLine]!)
		: null;
	if (!match || (expected !== undefined && match[2].trim() !== expected) ||
		![...scanPlanMarkdown(plan)].some(({ index }) => index === sourceLine)) {
		throw new Error("The saved plan changed and the selected implementation step can no longer be updated safely");
	}
	if (!text.trim() || /[\r\n]/.test(text)) throw new Error("A plan step must be a nonempty single-line instruction");
	const trailing = lines[sourceLine].match(/\s*$/)![0];
	lines[sourceLine] = `${match[1]}${text.trim()}${trailing}`;
	return lines.join(newline);
}

export function executablePlanStep(state: PlanExecutionState | undefined): PlanStep | undefined {
	return state?.status === "running" ? activePlanStep(state) : undefined;
}

export function activePlanStep(state: PlanExecutionState | undefined): PlanStep | undefined {
	return state?.steps.find((step) => step.status === "active");
}
