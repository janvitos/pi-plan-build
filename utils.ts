import path from "node:path";
import { scanPlanMarkdown } from "./plan-markdown.ts";
import fs from "node:fs";
import { decodePlanExecution, type PlanExecutionState } from "./plan-execution.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { VERIFICATION_GUIDANCE } from "./prompts.ts";

export type Mode = "build" | "plan";

const MODE_LABELS: Record<Mode, string> = {
	plan: "plan",
	build: "build",
};

type ModeThemeColor = "warning" | "thinkingLow";

export interface ModeStatusTheme {
	bold(text: string): string;
	fg(color: "dim" | "accent" | ModeThemeColor, text: string): string;
}

export interface PromptMetadataOptions {
	modelName: string;
	modelProvider?: string;
	rail?: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function nextThinkingLevel(
	current: ThinkingLevel,
	model: { reasoning: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, unknown>> } | undefined,
): ThinkingLevel | undefined {
	if (!model?.reasoning) return undefined;
	const available = THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		return level !== "xhigh" && level !== "max" || mapped !== undefined;
	});
	const currentIndex = available.indexOf(current);
	return available[(currentIndex + 1) % available.length];
}

function modeThemeColor(mode: Mode): ModeThemeColor {
	return mode === "plan" ? "warning" : "thinkingLow";
}

function formatModeColor(mode: Mode, text: string, theme: ModeStatusTheme): string {
	return theme.fg(modeThemeColor(mode), text);
}

export function formatModeRail(mode: Mode, theme: ModeStatusTheme, glyph = "│"): string {
	return formatModeColor(mode, glyph, theme);
}

export function formatModeTopBorder(
	mode: Mode,
	width: number,
	topRightCorner: string,
	theme: ModeStatusTheme,
	title?: string,
): string {
	if (width <= 2) return "";
	if (!title) return `${formatModeColor(mode, `╭${"─".repeat(width - 2)}`, theme)}${topRightCorner}`;
	const label = title ? truncateToWidth(` ${cleanTaskTitle(title)} `, Math.max(0, width - 3), "…") : "";
	return `${formatModeColor(mode, "╭", theme)}${label ? theme.fg("accent", label) : ""}${formatModeColor(mode, `${"─".repeat(Math.max(0, width - 2 - visibleWidth(label)))}`, theme)}${topRightCorner}`;
}

export function formatModeMetadata(
	mode: Mode,
	thinkingLevel: string,
	theme: ModeStatusTheme,
	thinkingColor: (text: string) => string,
	options?: PromptMetadataOptions,
): string {
	const modeText = formatModeColor(mode, theme.bold(MODE_LABELS[mode]), theme);
	const modelText = options
		? `${theme.fg("dim", " · ")}${options.modelName}${
			options.modelProvider ? theme.fg("dim", ` [${options.modelProvider}]`) : ""
		}`
		: "";
	const thinkingSeparator = " · ";
	return `${options?.rail === "" ? "" : `${options?.rail ?? formatModeRail(mode, theme)} `}${modeText}${modelText}${theme.fg("dim", thinkingSeparator)}${thinkingColor(thinkingLevel)}`;
}

export function shouldReduceOptionalUi(currentOwner: unknown, acceptedOwner: unknown): boolean {
	return acceptedOwner === undefined ? currentOwner !== undefined : currentOwner !== acceptedOwner;
}

export function ownsUiSlot(currentOwner: unknown, installedOwner: unknown): boolean {
	return installedOwner !== undefined && currentOwner === installedOwner;
}

export interface LineWidthTools {
	truncate(line: string, width: number): string;
	measure(line: string): number;
}

export function renderModeComposer(
	lines: string[],
	topBorder: string,
	leftRailPrefix: string,
	rightRail: string,
	metadata: string,
	bottomLeftCorner: string,
	reservedWidth: number,
	width: number,
	lineWidth: LineWidthTools,
	borderColor: (text: string) => string = (text) => text,
): string[] {
	if (reservedWidth <= 0 || width <= 1 || lines.length < 3) return lines;
	const reservedPrefix = " ".repeat(reservedWidth);
	const bottomBorderIndex = lines.findIndex((line, index) => index > 0 && !line.startsWith(reservedPrefix));
	if (bottomBorderIndex < 2) return lines;

	const addRightRail = (line: string, rail = rightRail): string => {
		const content = lineWidth.truncate(line, width - 1);
		return `${content}${" ".repeat(Math.max(0, width - 1 - lineWidth.measure(content)))}${rail}`;
	};
	const promptLines = lines
		.slice(1, bottomBorderIndex)
		.map((line) => addRightRail(leftRailPrefix + line.slice(reservedPrefix.length)));
	const label = truncateToWidth(` ${metadata} `, Math.max(0, width - 2), "…");
	const bottomBorder = bottomLeftCorner + label + borderColor("─".repeat(Math.max(0, width - 2 - visibleWidth(label))) + "╯");
	return [
		topBorder,
		addRightRail(leftRailPrefix),
		...promptLines,
		addRightRail(leftRailPrefix),
		bottomBorder,
		"",
		...lines.slice(bottomBorderIndex + 1),
	];
}

export const PLAN_EXIT_APPROVE_CHOICE = "Switch to Build and implement here";
export const PLAN_EXIT_FRESH_CHOICE = "Start fresh and implement";
export const PLAN_EXIT_STAY_CHOICE = "Stay in Plan mode";
export const PLAN_EXIT_STAY_ACKNOWLEDGEMENT =
	"I’ll stay in Plan mode and wait for your next instruction.";
export const PLAN_ACTION_ANNOUNCEMENTS = {
	"implement-here": "I’ll switch to Build mode and implement the approved plan in this session.",
	"implement-fresh": "I’ll implement the approved plan in this clean session.",
	"step-by-step": "I’ll open step-by-step execution and wait for your instruction before starting a step.",
	stay: PLAN_EXIT_STAY_ACKNOWLEDGEMENT,
} as const;
export const PLAN_STEP_READY_ACKNOWLEDGEMENT = "Write “Proceed” to start the first step. Instructions are shown at the bottom of the plan panel.";

export type PlanExitDecision = "implement-here" | "implement-fresh" | "stay";

export interface NormalizedPlanExitChoice {
	choice: string;
	cancelled: boolean;
}

export function normalizePlanExitChoice(choice: string | undefined): NormalizedPlanExitChoice {
	return {
		choice: choice ?? PLAN_EXIT_STAY_CHOICE,
		cancelled: choice === undefined,
	};
}

export function classifyPlanExitChoice(choice: string): PlanExitDecision {
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
				text: "Fresh-session implementation selected.",
			},
		],
		details: { approved: true, action: "implement-fresh" as const, mode: "plan" as const, planPath },
		terminate: true,
	};
}

export interface FreshImplementationRequest {
	plan: string;
	model?: { provider: string; id: string };
	thinkingLevel: string;
}

export function buildFreshImplementationRequest(
	plan: string,
	model: { provider: string; id: string } | undefined,
	thinkingLevel: string,
): FreshImplementationRequest {
	return { plan, model, thinkingLevel };
}

export function buildFreshImplementationHandoff(plan: string): string {
	return `Plan mode is now disabled. Full tool access is restored.\n\n${VERIFICATION_GUIDANCE}\n\nImplement this approved plan now:\n\n${plan}`;
}

export function buildPlanExitStayResult(planPath: string, cancelled: boolean) {
	return {
		content: [
			{
				type: "text" as const,
				text: "Remaining in Plan mode.",
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

export function cleanTaskTitle(title: string): string {
	return title.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

export function extractPlanTitle(markdown: string): string | undefined {
	for (const { line } of scanPlanMarkdown(markdown)) {
		const heading = line.match(/^ {0,3}#\s+(.+)$/);
		if (heading) {
			const title = cleanTaskTitle(heading[1].replace(/\s+#+\s*$/, ""));
			if (title) return title;
		}
	}
	return undefined;
}

export function displayedPlanTitle(_mode: Mode, plan: PlanLifecycle, savedPlan: boolean, heading?: string): string | undefined {
	if (plan.status === "completed") return undefined;
	if (!plan.task && !savedPlan) return undefined;
	return cleanTaskTitle(plan.task?.title ?? "") || heading || "Untitled task";
}

export interface PlanTask {
	title: string;
	scope: string;
	decisions: Array<{ topic: string; outcome: "include" | "discussion" }>;
}

export interface PlanOutcome {
	kind: "awaiting_validation" | "blocked" | "waiting_for_input" | "still_working";
	reason: string;
	userAction?: string;
}

export interface PlanLifecycle {
	sequence: number;
	status: "open" | "completed";
	task?: PlanTask;
	outcome?: PlanOutcome;
}

export interface CompletionReconciliation {
	sequence: number;
	sessionId: string;
	eligible: boolean;
	consumed: boolean;
	handled: boolean;
	failed: boolean;
	terminal: boolean;
}

export function shouldReconcileCompletion(state: CompletionReconciliation | undefined, attached: number | null, mode: Mode, sessionId: string, hasExecution: boolean, idle: boolean, pending: boolean): boolean {
	return !!state && state.sequence === attached && state.sessionId === sessionId && mode === "build" && !hasExecution && idle && !pending && state.eligible && state.terminal && !state.consumed && !state.handled && !state.failed;
}

export function decodeCompletionReconciliation(value: unknown): CompletionReconciliation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const r = value as CompletionReconciliation;
	if (!Number.isSafeInteger(r.sequence) || r.sequence < 0 || typeof r.sessionId !== "string" || ![r.eligible, r.consumed, r.handled, r.failed, r.terminal].every((v) => typeof v === "boolean")) return undefined;
	return { ...r };
}

export function decodePlanLifecycle(value: unknown): PlanLifecycle | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<PlanLifecycle>;
	if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence! < 0 ||
		(candidate.status !== "open" && candidate.status !== "completed")) return undefined;
	const task = candidate.task;
	const validTask = task && typeof task.title === "string" && typeof task.scope === "string" &&
		Array.isArray(task.decisions) && task.decisions.every((d) => d && typeof d.topic === "string" && (d.outcome === "include" || d.outcome === "discussion"));
	const outcome = candidate.outcome;
	const validOutcome = outcome && ["awaiting_validation", "blocked", "waiting_for_input", "still_working"].includes(outcome.kind) && typeof outcome.reason === "string" && (outcome.userAction === undefined || typeof outcome.userAction === "string");
	if (candidate.task !== undefined && !validTask || candidate.outcome !== undefined && !validOutcome) return undefined;
	return { sequence: candidate.sequence!, status: candidate.status,
		...(validOutcome ? { outcome: { ...outcome } } : {}),
		...(validTask ? { task: { title: cleanTaskTitle(task.title), scope: task.scope, decisions: task.decisions.map((d) => ({ ...d })) } } : {}) };
}

export type PlanFileState = "saved" | "absent" | "unavailable";

export function inspectPlanFile(file: string): PlanFileState {
	try { return fs.statSync(file).isFile() ? "saved" : "unavailable"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable"; }
}

export function describePlanFileState(file: string, state: PlanFileState): string {
	if (state === "saved") return `Saved plan file: ${file}. Read it only when relevant to the current work.`;
	if (state === "absent") return `No plan file exists. Reserved path for future writing: ${file}. Do not read this absent file.`;
	return `Plan file unavailable: ${file}. Its existence could not be confirmed; do not assume it is absent or discard its task.`;
}

export interface SavedPlanRecord {
	plan: PlanLifecycle;
	execution?: PlanExecutionState;
}

export interface PlanCollection {
	records: SavedPlanRecord[];
	attached: number | null;
	counter: number;
}

export function decodePlanCollection(value: unknown): PlanCollection | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as Partial<PlanCollection>;
	if (!Array.isArray(data.records) || !Number.isSafeInteger(data.counter) || data.counter! < 0) return undefined;
	const records: SavedPlanRecord[] = [];
	for (const raw of data.records) {
		const plan = decodePlanLifecycle(raw?.plan);
		if (!plan || records.some((r) => r.plan.sequence === plan.sequence)) return undefined;
		const execution = decodePlanExecution(raw.execution);
		if (raw.execution !== undefined && !execution) return undefined;
		records.push({ plan, ...(execution ? { execution } : {}) });
	}
	if (data.attached !== null && !records.some((r) => r.plan.sequence === data.attached && r.plan.status === "open")) return undefined;
	return { records, attached: data.attached!, counter: Math.max(data.counter!, ...records.map((r) => r.plan.sequence)) };
}

export function makePlanPath(plansDir: string, sessionId: string | undefined, sequence = 0): string {
	if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid plan sequence");
	const root = path.resolve(plansDir);
	const suffix = sequence === 0 ? "" : `-${String(sequence).padStart(3, "0")}`;
	const candidate = path.resolve(root, `${sanitizeSessionId(sessionId)}${suffix}.md`);
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
	return !!planPath && resolved !== undefined && resolved === path.resolve(planPath);
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
