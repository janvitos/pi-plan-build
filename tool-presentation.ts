import { Text } from "@earendil-works/pi-tui";

export function resultText(result: { content: readonly { type: string; text?: string }[] }, fallback = ""): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") || fallback;
}

/** Error takes precedence over partial/success; specialized final renderers stay at the caller. */
export function pendingOrError(
	result: { content: readonly { type: string; text?: string }[] },
	options: { isPartial: boolean },
	theme: { fg(color: "error" | "muted", text: string): string },
	context: { isError?: boolean },
	pending: string,
	failure: string,
): Text | undefined {
	if (context.isError) return new Text(theme.fg("error", resultText(result, failure)), 0, 0);
	if (options.isPartial) return new Text(theme.fg("muted", pending), 0, 0);
	return undefined;
}
