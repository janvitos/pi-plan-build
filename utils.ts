import path, { isAbsolute, relative, resolve, sep } from "node:path";

export type Mode = "build" | "plan";

const ANSI_RESET = "\x1b[0m";
const MODE_LABELS: Record<Mode, { color: string; text: string }> = {
	plan: { color: "38;2;245;167;66", text: "plan" },
	build: { color: "38;2;92;156;245", text: "build" },
};

export interface ModeStatusTheme {
	bold(text: string): string;
	fg(color: "dim", text: string): string;
}

export interface PromptMetadataOptions {
	modelName: string;
	modelColor: (text: string) => string;
}

function formatModeColor(mode: Mode, text: string): string {
	return `\x1b[${MODE_LABELS[mode].color}m${text}${ANSI_RESET}`;
}

export function formatModeRail(mode: Mode): string {
	return formatModeColor(mode, "│");
}

export function formatModeTopBorder(mode: Mode, width: number): string {
	if (width <= 0) return "";
	return formatModeColor(mode, `╭${"─".repeat(width - 1)}`);
}

export function formatModeMetadata(
	mode: Mode,
	thinkingLevel: string,
	theme: ModeStatusTheme,
	thinkingColor: (text: string) => string,
	options?: PromptMetadataOptions,
): string {
	const label = MODE_LABELS[mode];
	const modeText = `\x1b[${label.color}m${theme.bold(label.text)}${ANSI_RESET}`;
	const modelText = options
		? `${theme.fg("dim", " • ")}${options.modelColor(options.modelName)}`
		: "";
	const thinkingSeparator = options ? " • " : " · ";
	return `${formatModeRail(mode)} ${modeText}${modelText}${theme.fg("dim", thinkingSeparator)}${thinkingColor(thinkingLevel)}`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatFooterCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const relativeToHome = relative(resolve(home), resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function renderModeComposer(
	lines: string[],
	topBorder: string,
	railPrefix: string,
	metadata: string,
	reservedWidth: number,
): string[] {
	if (reservedWidth <= 0 || lines.length < 3) return lines;
	const reservedPrefix = " ".repeat(reservedWidth);
	const bottomBorderIndex = lines.findIndex((line, index) => index > 0 && !line.startsWith(reservedPrefix));
	if (bottomBorderIndex < 2) return lines;
	const promptLines = lines
		.slice(1, bottomBorderIndex)
		.map((line) => railPrefix + line.slice(reservedPrefix.length));
	const bottomBorder = lines[bottomBorderIndex]!.replace(
		/^((?:\x1b\[[0-?]*[ -/]*[@-~])*)./u,
		"$1 ",
	);
	return [
		topBorder,
		...promptLines,
		railPrefix,
		metadata,
		bottomBorder,
		"",
		...lines.slice(bottomBorderIndex + 1),
	];
}

export const PLAN_EXIT_APPROVE_CHOICE = "Switch to Build and implement here";
export const PLAN_EXIT_FRESH_CHOICE = "Start fresh and implement";
export const PLAN_EXIT_STAY_CHOICE = "Stay in Plan mode";
export const PLAN_EXIT_STAY_ACKNOWLEDGEMENT =
	"Staying in Plan mode. Let me know when you’re ready to revise or implement the plan.";

export type PlanExitDecision = "implement-here" | "implement-fresh" | "stay";

export function classifyPlanExitChoice(choice: string | undefined): PlanExitDecision {
	if (choice === PLAN_EXIT_APPROVE_CHOICE) return "implement-here";
	if (choice === PLAN_EXIT_FRESH_CHOICE) return "implement-fresh";
	return "stay";
}

export function buildPlanReviewMessage(plan: string): string {
	return `# Plan for Review\n\n${plan}`;
}

export function buildPlanExitFreshResult(planPath: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: "The user selected clean-session implementation. Stop now; the /build-fresh command has been prepared for the user to submit.",
			},
		],
		details: { approved: true, action: "implement-fresh" as const, mode: "plan" as const, planPath },
		terminate: true,
	};
}

export function buildFreshImplementationHandoff(plan: string): string {
	return `Plan mode is now disabled. Full tool access is restored. Implement this approved plan now:\n\n${plan}`;
}

export function buildPlanExitStayResult(planPath: string, cancelled: boolean) {
	return {
		content: [
			{
				type: "text" as const,
				text: "The user chose to stay in Plan mode. Stop now and wait for their next message before doing any further planning or taking any other action.",
			},
		],
		details: { approved: false, mode: "plan" as const, planPath, cancelled },
		terminate: true,
	};
}

export interface PersistedModeState {
	version: 1;
	selectedMode: Mode;
}

export function isMode(value: unknown): value is Mode {
	return value === "build" || value === "plan";
}

export function decodeModeState(value: unknown): PersistedModeState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { version?: unknown; selectedMode?: unknown; mode?: unknown };
	const mode = isMode(candidate.selectedMode) ? candidate.selectedMode : isMode(candidate.mode) ? candidate.mode : undefined;
	if (!mode) return undefined;
	return { version: 1, selectedMode: mode };
}

export function sanitizeSessionId(value: string | undefined): string {
	const cleaned = (value ?? "ephemeral")
		.normalize("NFKC")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 120);
	return cleaned || "ephemeral";
}

export function makePlanPath(plansDir: string, sessionId: string | undefined): string {
	const root = path.resolve(plansDir);
	const candidate = path.resolve(root, `${sanitizeSessionId(sessionId)}.md`);
	if (path.dirname(candidate) !== root) throw new Error("Generated plan path escaped the plans directory");
	return candidate;
}

export function resolveToolPath(cwd: string, inputPath: unknown): string | undefined {
	if (typeof inputPath !== "string" || inputPath.trim() === "") return undefined;
	const withoutAt = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	return path.resolve(cwd, withoutAt);
}

export function isAllowedPlanMutation(cwd: string, inputPath: unknown, planPath: string): boolean {
	const resolved = resolveToolPath(cwd, inputPath);
	return resolved !== undefined && resolved === path.resolve(planPath);
}

export interface QuestionAnswerData {
	question: string;
	header: string;
	answers: string[];
	custom: boolean;
}

export function formatQuestionAnswers(answers: QuestionAnswerData[]): string {
	return answers.map((answer) => `"${answer.question}"="${answer.answers.length ? answer.answers.join(", ") : "Unanswered"}"`).join(", ");
}

export function extractPromptHistory(entries: readonly unknown[], limit = 100): string[] {
	const prompts: string[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as {
			type?: unknown;
			message?: { role?: unknown; content?: unknown };
		};
		if (candidate.type !== "message" || candidate.message?.role !== "user") continue;

		const content = candidate.message.content;
		const text = typeof content === "string"
			? content
			: Array.isArray(content)
				? content
					.filter((block): block is { type: "text"; text: string } =>
						!!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
					.map((block) => block.text)
					.join("")
				: "";
		const trimmed = text.trim();
		if (!trimmed || prompts.at(-1) === trimmed) continue;
		prompts.push(trimmed);
	}
	const maxEntries = Math.max(0, Math.floor(limit));
	return maxEntries === 0 ? [] : prompts.slice(-maxEntries);
}

export function nextMode(mode: Mode): Mode {
	return mode === "build" ? "plan" : "build";
}

export function applyManualSelection(selectedMode: Mode, runMode: Mode | undefined, idle: boolean): {
	selectedMode: Mode;
	runMode: Mode | undefined;
} {
	return { selectedMode, runMode: idle ? selectedMode : runMode };
}

export function unique(values: string[]): string[] {
	return [...new Set(values)];
}
