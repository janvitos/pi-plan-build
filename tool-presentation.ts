import { getMarkdownTheme, type Theme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { formatInstruction } from "./utils.ts";

export function resultText(result: { content: readonly { type: string; text?: string }[] }, fallback = ""): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") || fallback;
}

/** Call rows own pending feedback; settled rows are result-only. */
export function statusCall(pending: string) {
	return (_args: unknown, theme: Theme, context?: { isPartial?: boolean; isError?: boolean }) =>
		context?.isPartial && !context.isError ? new Text(theme.fg("muted", pending), 0, 0) : new Container();
}

/** Correlate existing durable UI notices without changing model-visible tool results. */
export function noticeTracker(pi: ExtensionAPI, type: string) {
	const ids = new Set<string>();
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		ids.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== type) continue;
			const id = (entry.data as { toolCallId?: unknown } | undefined)?.toolCallId;
			if (typeof id === "string") ids.add(id);
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	return {
		append(message: string, toolCallId: string, data: Record<string, unknown> = {}) {
			pi.appendEntry(type, { message, toolCallId, ...data });
			ids.add(toolCallId);
		},
		has(context: { toolCallId?: string }) { return !!context.toolCallId && ids.has(context.toolCallId); },
	};
}

/** Error takes precedence over partial/success; specialized final renderers stay at the caller. */
export function pendingOrError(
	result: { content: readonly { type: string; text?: string }[] },
	options: { isPartial: boolean },
	theme: { fg(color: "error" | "muted", text: string): string },
	context: { isError?: boolean },
	_pending: string,
	failure: string,
): Text | Container | undefined {
	if (context.isError) return new Text(theme.fg("error", resultText(result, failure)), 0, 0);
	if (options.isPartial) return new Container();
	return undefined;
}

function stepHandoffParts(text: string): { confirmation: string; instruction: string } | undefined {
	const nextStep = text.indexOf(". The next step");
	if (nextStep >= 0) return { confirmation: text.slice(0, nextStep + 1), instruction: text.slice(nextStep + 2) };
	const approval = text.indexOf(" and is awaiting user approval.");
	if (approval >= 0) return { confirmation: text.slice(0, approval), instruction: text.slice(approval + 1) };
	return undefined;
}

/** Both step tools share a Markdown completion summary and compact ordinary results. */
export function renderStepResult(
	result: { content: readonly { type: string; text?: string }[]; details?: unknown },
	options: { isPartial: boolean },
	theme: Theme,
	context: { isError?: boolean; args?: Record<string, unknown> },
	pending: string,
	fallback: string,
): Text | Markdown | Container {
	const status = pendingOrError(result, options, theme, context, pending, fallback);
	if (status) return status;
	const details = result.details as { action?: string; completed?: boolean; changed?: boolean; planCompleted?: boolean; stepId?: string; awaitingUser?: boolean; confirmation?: string; instruction?: string } | undefined;
	const text = resultText(result, fallback);
	if (details?.planCompleted) return new Markdown(text, 0, 0, getMarkdownTheme());
	const storedStep = typeof details?.stepId === "string" ? /^step-(\d+)$/.exec(details.stepId)?.[1] : undefined;
	const requested = context.args?.step;
	const step = storedStep ? Number(storedStep) : typeof requested === "number" ? Math.floor(requested) : undefined;
	const prefix = Number.isInteger(step) && step! > 0 ? `Step ${step}: ` : "";
	const handoff = details?.awaitingUser
		? details.confirmation && details.instruction ? { confirmation: details.confirmation, instruction: details.instruction } : stepHandoffParts(text)
		: undefined;
	if (handoff) return new Text(`${theme.fg("success", `${prefix}${handoff.confirmation}`)} ${formatInstruction(theme, handoff.instruction)}`, 0, 0);
	const line = `${prefix}${text}`;
	if (details?.awaitingUser) return new Text(formatInstruction(theme, line), 0, 0);
	if (details?.changed === false || text.startsWith("Plan execution is already ") || !details?.action && !details?.completed && !details?.stepId) return new Text(theme.fg("muted", line), 0, 0);
	return new Text(theme.fg("success", line), 0, 0);
}
