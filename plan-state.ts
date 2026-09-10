import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { decodePlanExecution, type PlanExecutionState } from "./plan-execution.ts";
import { decodePlanCollection, decodePlanLifecycle, type PlanCollection, type PlanFileState, type PlanLifecycle, type PlanOutcome, type PlanTask, type Mode } from "./utils.ts";

export const STATE_VERSION = 3;
export const STATE_TYPE = "pi-plan-build-state";
export const LEGACY_STATE_TYPE = "opencode-modes-state";
export interface StoredState {
	version: typeof STATE_VERSION;
	selectedMode: Mode;
	collection: PlanCollection;
	toolsBeforeModes: string[];
	planSessionId?: string;
	pendingFreshAnnouncement?: boolean;
	// Run eligibility/failure/terminal flags are deliberately not durable.
	reconciliation?: { sequence: number; sessionId: string; consumed: true };
}

export interface LegacyState {
	version?: number;
	selectedMode?: Mode;
	collection?: unknown;
	plan?: unknown;
	execution?: unknown;
	toolsBeforeModes?: string[];
	planSessionId?: string;
	pendingFreshAnnouncement?: boolean;
	reconciliation?: unknown;
}

/** Branch-local lookup shared by startup and tree navigation. */
export function latestPlanState(entries: readonly SessionEntry[]): LegacyState | undefined {
	const entry = entries.findLast((entry) => entry.type === "custom" && (entry.customType === STATE_TYPE || entry.customType === LEGACY_STATE_TYPE));
	return entry?.type === "custom" ? entry.data as LegacyState : undefined;
}

/** One compatibility boundary. A present but unusable collection never falls back to its legacy mirror. */
export function restoreCollection(raw: LegacyState | undefined, inspect: (sequence: number) => PlanFileState, inspectSource?: (sequence: number) => PlanFileState): PlanCollection {
	if (raw?.version !== undefined && ![1, 2, STATE_VERSION].includes(raw.version)) throw new Error("Unsupported plan state version");
	let collection: PlanCollection;
	const hasCollection = !!raw && ("collection" in raw || raw.version === 2 || raw.version === STATE_VERSION);
	if (hasCollection) {
		const decoded = decodePlanCollection(raw!.collection);
		if (!decoded) throw new Error("Malformed plan collection; refusing to discard tracked plans");
		// Detached records from the former multi-plan workflow are inert history.
		// Preserve them structurally; do not migrate, attach, or surface them.
		return decoded;
	} else {
		const execution = decodePlanExecution(raw?.execution);
		const plan = decodePlanLifecycle(raw?.plan);
		if ((raw?.plan !== undefined && !plan) || (raw?.execution !== undefined && !execution)) throw new Error("Malformed legacy plan state");
		const legacy = plan ?? (execution || inspect(0) !== "absent" ? { sequence: 0, status: "open" as const } : undefined);
		collection = legacy ? { records: [{ plan: legacy, ...(execution ? { execution } : {}) }], attached: legacy.status === "open" ? legacy.sequence : null, counter: legacy.sequence } : { records: [], attached: null, counter: 0 };
	}
	collection.records = collection.records.filter(({ plan, execution }) => {
		if (plan.status !== "open" || plan.task || plan.outcome || execution || inspect(plan.sequence) !== "absent" || (inspectSource && inspectSource(plan.sequence) !== "absent")) return true;
		if (collection.attached === plan.sequence) collection.attached = null;
		return false;
	});
	return collection;
}

/** Recover allocation only, without decoding historical task/execution payloads. */
export function allocationHighWater(entries: readonly unknown[]): number {
	let counter = 0;
	const take = (value: unknown) => { if (Number.isSafeInteger(value) && (value as number) >= 0) counter = Math.max(counter, value as number); };
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; data?: { collection?: { counter?: unknown; records?: Array<{ plan?: { sequence?: unknown } }> }; plan?: { sequence?: unknown } } } | null;
		if (e?.type !== "custom" || (e.customType !== STATE_TYPE && e.customType !== LEGACY_STATE_TYPE)) continue;
		take(e.data?.collection?.counter);
		take(e.data?.plan?.sequence);
		if (Array.isArray(e.data?.collection?.records)) {
			for (const record of e.data.collection.records) take(record?.plan?.sequence);
		}
	}
	return counter;
}

/** Canonical collection plus validated, atomic plan transitions. No render or run state. */
export class PlanState {
	collection: PlanCollection = { records: [], attached: null, counter: 0 };
	error?: string;
	get attached() { return this.collection.records.find((r) => r.plan.sequence === this.collection.attached); }
	get plan(): PlanLifecycle {
		const record = this.attached;
		if (!record) throw new Error("No attached plan");
		return record.plan;
	}
	get execution(): PlanExecutionState | undefined { return this.attached?.execution; }
	assertUsable(): void { if (this.error) throw new Error(this.error); }
	private requireAttached() {
		this.assertUsable();
		const record = this.attached;
		if (!record) throw new Error("No attached plan");
		return record;
	}
	restore(collection: PlanCollection, highWater: number): void {
		this.collection = { ...collection, counter: Math.max(collection.counter, highWater) };
		this.error = undefined;
	}
	newPlan(sequence: number, task?: PlanTask): void {
		this.assertUsable();
		if (this.attached) throw new Error("Complete or explicitly abandon the current plan before starting another");
		if (!Number.isSafeInteger(sequence) || sequence <= this.collection.counter) throw new Error("Invalid plan allocation");
		this.collection.records.push({ plan: { sequence, status: "open", ...(task ? { task } : {}) } });
		this.collection.attached = sequence;
		this.collection.counter = sequence;
	}
	updateTask(task: PlanTask): void { this.requireAttached().plan = { ...this.plan, task }; }
	outcome(outcome: PlanOutcome | undefined): void {
		const record = this.requireAttached();
		const { outcome: _previous, ...plan } = record.plan;
		record.plan = { ...plan, ...(outcome ? { outcome } : {}) };
	}
	updateExecution(execution: PlanExecutionState | undefined): void {
		const record = this.requireAttached();
		if (execution) record.execution = execution;
		else delete record.execution;
	}
	complete(): void {
		const record = this.requireAttached();
		const { outcome: _outcome, abandonReason: _reason, ...plan } = record.plan;
		record.plan = { ...plan, status: "completed" };
		delete record.execution;
		this.collection.attached = null;
	}
	abandon(reason: string): void {
		const record = this.requireAttached();
		const explanation = reason.trim();
		if (!explanation) throw new Error("Abandoning a plan requires a reason");
		const { outcome: _outcome, ...plan } = record.plan;
		record.plan = { ...plan, status: "abandoned", abandonReason: explanation };
		delete record.execution;
		this.collection.attached = null;
	}
}
