import { createHash } from "node:crypto";

/** Durable branch-local journal; records are metadata, projected into model context at immutable anchors. */
export const CONTEXT_DELIVERY_TYPE = "pi-plan-build-context-delivery";
export const ANCHORED_CONTEXT_TYPE = "pi-plan-build-task";
export interface Delivery {
	version: 1;
	anchor: string;
	placement: "before" | "after" | "tool";
	state: string;
	content: string;
}

type Message = { role: string; content?: any; timestamp?: number; customType?: string; toolCallId?: string; [key: string]: any };
const ORIGINAL = "piPlanBuildOriginalContent";

function unproject<T extends Message>(messages: T[]): T[] {
	return messages.filter((m) => !(m.customType === ANCHORED_CONTEXT_TYPE && m.piPlanBuildProjection === true)).map((m) => {
		if (!(ORIGINAL in m)) return m;
		const { [ORIGINAL]: content, ...original } = m;
		return { ...original, content } as T;
	});
}
function anchors(messages: Message[]): string[] {
	const occurrences = new Map<string, number>();
	return messages.map((m) => {
		const hash = createHash("sha256").update(JSON.stringify([m.role, m.timestamp, m.toolCallId, m.customType, m.content])).digest("hex");
		const occurrence = occurrences.get(hash) ?? 0;
		occurrences.set(hash, occurrence + 1);
		return `${hash}:${occurrence}`;
	});
}
export function deliveriesFrom(entries: readonly any[]): Delivery[] {
	return entries.filter((e) => e.type === "custom" && e.customType === CONTEXT_DELIVERY_TYPE)
		.map((e) => e.data).filter((d): d is Delivery => d?.version === 1 && typeof d.anchor === "string" && typeof d.state === "string" && typeof d.content === "string" && ["before", "after", "tool"].includes(d.placement));
}

/** Does not mutate transcript messages. A persisted anchor reproduces the same provider-facing content on retry/reload. */
export function deliverContext<T extends Message>(input: T[], journal: Delivery[], state: string | undefined): { messages: T[]; delivery?: Delivery } {
	const messages = unproject(input);
	// No conversation boundary exists yet. Return guidance but do not journal an
	// unanchored projection; real user/tool requests will establish a durable anchor.
	if (!messages.length) return { messages: state === undefined ? [] : [{ role: "custom", customType: ANCHORED_CONTEXT_TYPE, piPlanBuildProjection: true, content: state, display: false, timestamp: 0 } as unknown as T] };
	const keys = anchors(messages);
	const visible = journal.filter((d) => keys.includes(d.anchor));
	const latest = visible.at(-1);
	const legacyGuidance = messages.some((m) => m.role === "custom" && [ANCHORED_CONTEXT_TYPE, "pi-plan-build-reminder"].includes(m.customType ?? ""));
	// Empty Build still needs an explicit clearing update if old operational guidance survives.
	const effective = state ?? (latest || legacyGuidance ? "Build mode. Current plan: none. Previous plan and execution instructions are historical, not current authorization." : undefined);
	let delivery: Delivery | undefined;
	if (effective !== undefined && latest?.state !== effective) {
		const last = messages.at(-1);
		const index = messages.length - 1;
		delivery = {
			version: 1, anchor: keys[index] ?? "root",
			placement: last?.role === "toolResult" ? "tool" : last?.role === "user" ? "before" : "after",
			state: effective,
			content: `Background operational context, not a new user request. Do not acknowledge this block. This snapshot supersedes earlier Plan Build state and restrictions; it grants no approval beyond explicit user authorization. Earlier outcome-reconciliation requests apply only to their original bookkeeping follow-up, never later user turns.\n\n${effective}`,
		};
		visible.push(delivery);
	}
	const output: T[] = [];
	for (const [index, message] of messages.entries()) {
		const updates = visible.filter((d) => d.anchor === keys[index]);
		const custom = (d: Delivery) => ({ role: "custom", customType: ANCHORED_CONTEXT_TYPE, piPlanBuildProjection: true, content: d.content, display: false, timestamp: message.timestamp ?? 0 }) as unknown as T;
		output.push(...updates.filter((d) => d.placement === "before").map(custom));
		const toolUpdates = updates.filter((d) => d.placement === "tool");
		output.push(toolUpdates.length ? { ...message, [ORIGINAL]: message.content, content: [...message.content, ...toolUpdates.map((d) => ({ type: "text", text: d.content }))] } : message);
		output.push(...updates.filter((d) => d.placement === "after").map(custom));
	}
	return { messages: output, ...(delivery ? { delivery } : {}) };
}
