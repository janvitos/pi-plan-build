import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue, getAgentDir, getMarkdownTheme, parseSkillBlock, type EntryRenderer, type ExtensionAPI, type ExtensionContext, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { pendingOrError, resultText, renderStepResult, statusCall, noticeTracker } from "./tool-presentation.ts";
import { buildPlanContext, isObsoletePlanContext, TASK_CONTEXT_TYPE, RECONCILIATION_CONTEXT_TYPE } from "./plan-context.ts";
import { PlanState, restoreCollection, allocationHighWater, latestPlanState, STATE_VERSION, STATE_TYPE, LEGACY_STATE_TYPE, type StoredState, type LegacyState } from "./plan-state.ts";
import { registerQuestionTool } from "./question-ui.ts";
import { loadShortcutConfig, saveShortcutPreset, saveSmallCapsPlanTitle, SHORTCUT_PRESETS, shortcutPresetLabel } from "./shortcut-config.ts";
import {
	PLAN_ENTER_DESCRIPTION,
	PLAN_EXIT_DESCRIPTION,
	PLAN_STEP_COMPLETE_DESCRIPTION,
} from "./prompts.ts";
import {
	activePlanStep,
	executablePlanStep,
	completePlanStep,
	createPlanExecution,
	formatPlanCompletionSummary,
	pausePlanExecution,
	revisePlanStep,
	skipPlanStep,
	startPlanStep,
	updatePlanStepInstruction,
	type PlanExecutionState,
} from "./plan-execution.ts";
import { handoffSnapshot, startFreshHandoff, type ApprovedHandoff } from "./handoff.ts";
import { createComposer, PANEL_MIN_TERMINAL_WIDTH } from "./composer.ts";
import { collectTranscriptModeRecords, installUserMessageRail } from "./user-message-rail.ts";
import {
	applyManualSelection,
	buildFreshImplementationRequest,
	buildPlanExitFreshResult,
	buildPlanExitStayResult,
	buildPlanReviewMessage,
	classifyPlanExitChoice,
	decodeModeState,
	shouldReconcileCompletion,
	type CompletionReconciliation,
	type PlanOutcome,
	inspectPlanFile,
	cleanTaskTitle,
	displayedPlanTitle,
	extractPlanTitle,
	type PlanLifecycle,
	extractPromptHistory,
	extractUserMessageText,
	formatModeRail,
	isAllowedPlanMutation,
	makePlanPath,
	nextMode,
	normalizePlanExitChoice,
	PLAN_EXIT_APPROVE_CHOICE,
	PLAN_EXIT_FRESH_CHOICE,
	PLAN_ACTION_ANNOUNCEMENTS,
	PLAN_EXIT_STAY_CHOICE,
	PLAN_STEP_READY_ACKNOWLEDGEMENT,
	type Mode,
	unique,
} from "./utils.ts";

const PLAN_REVIEW_ENTRY_TYPE = "pi-plan-build-review";
const LEGACY_PLAN_REVIEW_ENTRY_TYPE = "opencode-plan-review";
const MODE_NOTICE_ENTRY_TYPE = "pi-plan-build-notice";
const LEGACY_MODE_NOTICE_ENTRY_TYPE = "opencode-mode-notice";
const PLAN_STEP_GUIDANCE_ENTRY_TYPE = "pi-plan-build-step-guidance";
const FRESH_ANNOUNCEMENT_MESSAGE_TYPE = "pi-plan-build-fresh-announcement";
const PLAN_STEP_CHOICE = "Implement step by step";
const MANAGED_TOOLS = new Set(["question", "plan_task", "plan_enter", "plan_exit", "plan_step_control", "plan_step_complete", "plan_complete", "plan_finish"]);
const MODE_ADDED_TOOLS = new Set([...MANAGED_TOOLS, "edit", "write"]);
const EMPTY_PARAMETERS = Type.Object({});


function shorten(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	const home = os.homedir();
	return filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}

export default function planBuildModes(pi: ExtensionAPI): void {
	const shortcutAgentDir = getAgentDir();
	const { config: shortcutConfig, smallCapsPlanTitle, path: shortcutConfigPath, warning: shortcutConfigWarning } = loadShortcutConfig(shortcutAgentDir);
	let shortcutConfigWarningShown = false;
	let selectedMode: Mode = "build";
	let runMode: Mode | undefined;
	let pendingFreshAnnouncement = false;
	const plans = new PlanState();
	let lastSnapshot = "";
	function currentPlanPath(): string {
		return plans.collection.attached !== null && currentContext ? planPathFor(plans.collection.attached, currentContext) : "";
	}
	let handoffSequence: number | undefined;
	let reconciliation: CompletionReconciliation | undefined;
	let reconciliationFollowUp = false;
	let activeReconciliationId: string | undefined;
	let savedPlanState: "saved" | "absent" | "unavailable" = "absent";
	let savedPlanHeading: string | undefined;
	let toolsBeforeModes: string[] = [];
	let currentContext: ExtensionContext | undefined;
	let freshImplementationRequest: ApprovedHandoff | undefined;
	const composer = createComposer(pi, { ...shortcutConfig, smallCapsPlanTitle }, () => ({ mode: selectedMode, title: currentPlanTitle(), awaitingValidation: plans.attached?.plan.outcome?.kind === "awaiting_validation", execution: plans.execution }), (mode, ctx) => { void selectMode(mode, ctx, "manual"); });
	const displayUserMessageText = (text: string): string | undefined => {
		const skillBlock = parseSkillBlock(text);
		return skillBlock ? skillBlock.userMessage || undefined : text || undefined;
	};
	const userMessageRail = installUserMessageRail(UserMessageComponent, {
		formatRail: (mode, glyph) => currentContext ? formatModeRail(mode, currentContext.ui.theme, glyph) : glyph,
		getFallbackMode: () => runMode ?? selectedMode,
	});
	const restoreUserMessageRails = (entries: readonly unknown[]) => {
		userMessageRail.setTranscript(
			collectTranscriptModeRecords(entries, {
				stateTypes: new Set([STATE_TYPE, LEGACY_STATE_TYPE]),
				decodeState: decodeModeState,
				displayText: displayUserMessageText,
			}),
		);
	};

	pi.registerFlag("plan", {
		description: "Start in Plan mode",
		type: "boolean",
		default: false,
	});

	registerQuestionTool(pi);
	const modeNotices = noticeTracker(pi, MODE_NOTICE_ENTRY_TYPE);
	const renderPlanReview: EntryRenderer<{ plan: string }> = (entry) => {
		const plan = typeof entry.data?.plan === "string" ? entry.data.plan : "Plan unavailable";
		return new Markdown(buildPlanReviewMessage(plan), 0, 0, getMarkdownTheme());
	};
	const renderModeNotice: EntryRenderer<{ message: string }> = (entry, _options, theme) => {
		const message = typeof entry.data?.message === "string" ? entry.data.message : "Plan mode unchanged.";
		return new Text(theme.fg("warning", message), 0, 0);
	};
	const renderPlanStepGuidance: EntryRenderer = (_entry, _options, theme) =>
		new Text(theme.fg("success", PLAN_STEP_READY_ACKNOWLEDGEMENT), 0, 0);
	pi.registerEntryRenderer<{ plan: string }>(PLAN_REVIEW_ENTRY_TYPE, renderPlanReview);
	pi.registerEntryRenderer<{ plan: string }>(LEGACY_PLAN_REVIEW_ENTRY_TYPE, renderPlanReview);
	pi.registerEntryRenderer<{ message: string }>(MODE_NOTICE_ENTRY_TYPE, renderModeNotice);
	pi.registerEntryRenderer<{ message: string }>(LEGACY_MODE_NOTICE_ENTRY_TYPE, renderModeNotice);
	pi.registerEntryRenderer(PLAN_STEP_GUIDANCE_ENTRY_TYPE, renderPlanStepGuidance);
	pi.registerMessageRenderer(FRESH_ANNOUNCEMENT_MESSAGE_TYPE, (message, _options, theme) =>
		new Text(theme.fg("warning", typeof message.content === "string" ? message.content : ""), 0, 0));

	function stateData(): StoredState {
		return { version: STATE_VERSION, selectedMode, collection: plans.collection, toolsBeforeModes, planSessionId: currentContext?.sessionManager.getSessionId(), ...(pendingFreshAnnouncement ? { pendingFreshAnnouncement: true } : {}), ...(reconciliation?.consumed ? { reconciliation: { sequence: reconciliation.sequence, sessionId: reconciliation.sessionId, consumed: true as const } } : {}) };
	}

	function persist(): void {
		if (plans.error) return; // Never overwrite an unusable collection with partial reconstruction.
		const snapshot = JSON.stringify(stateData());
		if (snapshot === lastSnapshot) return;
		pi.appendEntry(STATE_TYPE, JSON.parse(snapshot));
		lastSnapshot = snapshot;
	}

	function syncPlanState(ctx = currentContext): void {
		applyTools(runMode ?? selectedMode);
		if (ctx) composer.update(ctx);
		if (plans.execution) composer.ensurePanel();
		else composer.removePanel();
		persist();
	}

	function updateExecution(next: PlanExecutionState): void {
		plans.updateExecution(next);
		syncPlanState();
	}

	function currentPlanTitle(): string | undefined {
		if (plans.collection.attached === null) return undefined;
		return displayedPlanTitle(plans.plan, savedPlanState === "saved", savedPlanHeading);
	}

	function completablePlanStep() {
		return executablePlanStep(plans.execution) ?? (plans.plan.outcome?.kind === "awaiting_validation" ? activePlanStep(plans.execution) : undefined);
	}

	function completeExecutionStep(id: string, summary?: string): string | undefined {
		const execution = plans.execution!;
		const validated = plans.plan.outcome?.kind === "awaiting_validation" && execution.status === "paused" && activePlanStep(execution)?.id === id;
		const next = completePlanStep(validated ? pausePlanExecution(execution) : execution, id, summary);
		if (validated) plans.outcome(undefined);
		return applyExecutionTransition(next);
	}

	function refreshSavedPlanTitle(knownState?: typeof savedPlanState): void {
		savedPlanState = knownState ?? (currentPlanPath() ? inspectPlanFile(currentPlanPath()) : "absent");
		savedPlanHeading = undefined;
		if (savedPlanState !== "saved" || plans.attached?.plan.task?.title) return;
		try { savedPlanHeading = extractPlanTitle(fs.readFileSync(currentPlanPath(), "utf8")); }
		catch { /* An unreadable saved plan must not break the composer. */ }
	}

	function cancelPlanExecution(): void {
		plans.updateExecution(undefined);
		syncPlanState();
	}

	function applyExecutionTransition(next: PlanExecutionState): string | undefined {
		if (next.status !== "completed") {
			updateExecution(next);
			return undefined;
		}
		const summary = formatPlanCompletionSummary(next);
		closeCurrentPlan();
		return summary;
	}

	function discoverUnmanagedTools(): void {
		const additions = pi.getActiveTools().filter((name) => !MODE_ADDED_TOOLS.has(name) && !toolsBeforeModes.includes(name));
		toolsBeforeModes = unique([...toolsBeforeModes, ...additions]);
	}

	function applyTools(mode: Mode): void {
		discoverUnmanagedTools();
		const base = [...toolsBeforeModes];
		if (mode === "plan") {
			pi.setActiveTools(unique([...base, "edit", "write", "question", "plan_exit", "plan_task"]));
		} else {
			pi.setActiveTools(unique([
				...base,
				"question",
				"plan_enter",
				"plan_task",
				...(plans.collection.attached !== null && !plans.execution && plans.plan.status === "open" && savedPlanState === "saved" ? ["plan_complete", "plan_finish"] : []),
				...(plans.collection.attached !== null && plans.execution ? ["plan_finish"] : []),
				...(plans.execution && plans.execution.status !== "completed" ? ["plan_step_control"] : []),
				...(plans.collection.attached !== null && completablePlanStep() ? ["plan_step_complete"] : []),
			]));
		}
	}

	async function ensurePlanDirectory(): Promise<void> {
		await fs.promises.mkdir(path.join(getAgentDir(), "plans"), { recursive: true });
	}

	function currentPlanItem() {
		if (!plans.attached) return undefined;
		const plan = plans.plan;
		return { sequence: plan.sequence, title: plan.task?.title ?? savedPlanHeading ?? "Untitled task", state: plan.outcome?.kind === "awaiting_validation" ? "awaiting_validation" : "current", path: currentPlanPath(), fileState: savedPlanState, ...(plan.outcome ? { outcome: plan.outcome } : {}) };
	}

	function planInventory(): string {
		plans.assertUsable();
		const item = currentPlanItem();
		if (!item) return "Current plan: none.";
		const status = item.state === "awaiting_validation" ? "awaiting validation" : "open";
		return `Current plan: ${item.sequence} · ${item.title} · ${status}`;
	}

	function taskResult(action: string, title: string, changed = true) {
		const labels: Record<string, string> = { update: "Plan title/scope updated", include: "Plan scope updated", discussion: "Discussion decision saved", new: "New plan started", abandon: "Plan abandoned" };
		const item = action === "list" ? currentPlanItem() : undefined;
		const text = action === "list" ? planInventory() : `${changed ? labels[action] ?? "Plan updated" : "Plan unchanged"}: ${title}`;
		return { content: [{ type: "text" as const, text }], details: { action, attached: plans.collection.attached, ...(plans.collection.attached !== null ? { planPath: currentPlanPath(), fileState: savedPlanState, plan: structuredClone(plans.plan) } : {}), ...(action === "list" ? { plans: item ? [item] : [] } : {}) } };
	}

	function planPathFor(sequence: number, ctx: ExtensionContext): string {
		return makePlanPath(path.join(getAgentDir(), "plans"), ctx.sessionManager.getSessionId(), sequence);
	}

	function clearAttachmentRun(): void {
		activeReconciliationId = undefined;
		if (reconciliation) reconciliation.handled = true;
		freshImplementationRequest = undefined;
		pendingFreshAnnouncement = false;
		handoffSequence = undefined;
	}

	function syncAttachment(ctx = currentContext): void {
		refreshSavedPlanTitle();
		syncPlanState(ctx);
	}

	function closeCurrentPlan(): void {
		plans.complete();
		clearAttachmentRun();
		syncAttachment();
	}

	function abandonCurrentPlan(reason: string, ctx: ExtensionContext): string {
		const title = plans.plan.task?.title ?? "Untitled task";
		plans.abandon(reason);
		clearAttachmentRun();
		syncAttachment(ctx);
		return title;
	}

	function startNewPlan(ctx: ExtensionContext, task?: PlanLifecycle["task"]): void {
		plans.assertUsable();
		let sequence = plans.collection.counter;
		for (;;) {
			if (!Number.isSafeInteger(++sequence)) throw new Error("Plan allocation exhausted");
			const status = inspectPlanFile(planPathFor(sequence, ctx));
			if (status === "unavailable") throw new Error("Plan allocation path unavailable; refusing to overwrite it");
			if (status === "absent") break;
		}
		plans.newPlan(sequence, task);
		clearAttachmentRun();
		syncAttachment(ctx);
	}

	function completeCurrentPlan(): void {
		plans.assertUsable();
		if ((runMode ?? selectedMode) !== "build") throw new Error("Switch to Build mode before completing implementation");
		if (plans.collection.attached === null) throw new Error("No current plan to complete");
		if (plans.execution) throw new Error("Complete or cancel the step-by-step execution first");
		if (!fs.existsSync(currentPlanPath())) throw new Error("No saved plan to complete");
		closeCurrentPlan();
	}

	async function selectMode(mode: Mode, ctx: ExtensionContext, source: "manual" | "tool"): Promise<void> {
		if (mode === selectedMode && (source === "manual" || mode === runMode)) return;
		activeReconciliationId = undefined;
		if (mode !== "build" && reconciliation) reconciliation.handled = true;


		if (source === "manual") {
			const next = applyManualSelection(mode, runMode, ctx.isIdle());
			selectedMode = next.selectedMode;
			runMode = next.runMode;
			if (ctx.isIdle()) applyTools(mode);
		} else {
			selectedMode = mode;
			runMode = mode;
			applyTools(mode);
		}
		composer.update(ctx);
		persist();
	}

	pi.registerCommand("plan", {
		description: "Plan mode and lifecycle: new, done, abandon, list",
		getArgumentCompletions: (prefix) => ["new", "done", "abandon", "list"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [action, target, ...extra] = args.trim().split(/\s+/);
			if (!action) return selectMode("plan", ctx, "manual");
			if (!["new", "done", "abandon", "list", "pause", "resume"].includes(action) || extra.length || (target && action !== "resume")) {
				ctx.ui.notify("Usage: /plan [new|done|abandon|list]", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish before changing the current plan.", "warning");
				return;
			}
			if (action === "pause" || action === "resume") {
				ctx.ui.notify("Plan pause/resume is no longer supported. Complete or explicitly abandon the current plan before starting another.", "warning");
				return;
			}
			if (action === "list") {
				ctx.ui.notify(planInventory(), "info");
				return;
			}
			if (action === "done") {
				try {
					completeCurrentPlan();
					ctx.ui.notify("Plan completed. The next planning task will use a new file.", "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
				return;
			}
			if (action === "abandon") {
				try {
					if (!plans.attached) throw new Error("No current plan to abandon");
					if (!ctx.hasUI || !await ctx.ui.confirm("Abandon current plan?", `${plans.plan.task?.title ?? "Untitled task"}\n\nThe plan file will be preserved, but this plan cannot be resumed.`)) return;
					const title = abandonCurrentPlan("Explicitly abandoned by the user through /plan abandon.", ctx);
					ctx.ui.notify(`Plan abandoned: ${title}. Its file was preserved.`, "info");
				} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
				return;
			}
			try {
				plans.assertUsable();
				if (plans.attached) throw new Error("Complete or explicitly abandon the current plan before starting another");
				selectedMode = "plan";
				runMode = undefined;
				startNewPlan(ctx);
				await ensurePlanDirectory();
				ctx.ui.notify(`New plan: ${shorten(currentPlanPath(), ctx.cwd)}. Previous plan files are preserved.`, "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
		},
	});
	pi.registerCommand("build", {
		description: "Switch to Build mode",
		handler: async (_args, ctx) => selectMode("build", ctx, "manual"),
	});
	pi.registerCommand("plan-settings", {
		description: "Configure Plan/Build shortcuts and small-caps composer titles",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const customOption = "Custom (edit config file)";
			const titleOption = `Small-caps plan titles (active: ${smallCapsPlanTitle ? "enabled" : "disabled"})`;
			const selected = await ctx.ui.select(
				`Plan/Build shortcuts — active: ${shortcutPresetLabel(shortcutConfig)} (global: ${shortcutConfig.toggleMode.join(", ") || "none"}; editor: ${shortcutConfig.toggleModeInEditor.join(", ") || "none"})`,
				[...Object.keys(SHORTCUT_PRESETS), titleOption, customOption],
			);
			if (!selected) return;
			if (selected === titleOption) {
				const choice = await ctx.ui.select("Composer-outline small-caps plan titles", ["Enabled (default)", "Disabled"]);
				if (!choice) return;
				try {
					saveSmallCapsPlanTitle(shortcutAgentDir, choice === "Enabled (default)");
					ctx.ui.notify(`Saved small-caps plan titles: ${choice}. Run /reload to apply.`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not save ${shortcutConfigPath}: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (selected === customOption) {
				ctx.ui.notify(
					`Edit ${shortcutConfigPath}, then run /reload. Example: {"smallCapsPlanTitle":false,"shortcuts":{"toggleMode":["ctrl+alt+m"],"toggleModeInEditor":["tab"]}}. Use [] to disable an action. Put Tab only in toggleModeInEditor; it switches modes when autocomplete is closed instead of requesting file completion.`,
					"info",
				);
				return;
			}
			try {
				saveShortcutPreset(shortcutAgentDir, selected);
				ctx.ui.notify(`Saved ${selected} to ${shortcutConfigPath}. Run /reload to apply the shortcuts.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not save ${shortcutConfigPath}: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
	for (const shortcut of shortcutConfig.toggleMode) {
		pi.registerShortcut(shortcut, {
			description: "Cycle Plan and Build modes",
			handler: async (ctx) => selectMode(nextMode(selectedMode), ctx, "manual"),
		});
	}
	pi.registerCommand("build-fresh", {
		description: "Start a clean linked session and implement the plan selected in plan_exit",
		handler: async (_args, ctx) => {
			const request = freshImplementationRequest;
			if (request && (plans.collection.attached === null || handoffSequence !== plans.collection.attached)) {
				freshImplementationRequest = undefined;
				ctx.ui.notify("The approved plan is no longer current. Select its implementation action again.", "warning");
				return;
			}
			if (!request) {
				ctx.ui.notify("No fresh implementation is pending. Choose ‘Start fresh and implement’ from plan_exit first.", "warning");
				return;
			}
			if (selectedMode !== "plan") {
				freshImplementationRequest = undefined;
				ctx.ui.notify("Fresh implementation is no longer available because Plan mode is not active.", "warning");
				return;
			}
			freshImplementationRequest = undefined;
			try {
				if (await startFreshHandoff(pi, ctx, request)) freshImplementationRequest = request;
			} catch (error) {
				freshImplementationRequest = request;
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "plan_task",
		label: "Plan Task",
		description: "Manage the single current plan without editing Markdown. list reports only the current plan. new is Plan-only and requires no current plan. abandon is irreversible lifecycle closure, preserves the file, requires explicit user direction and a reason, and never implies success. update establishes identity once, then changes it only for user-driven material deliverable/constraint changes, explicit renames, or correction of mistaken identity. include/discussion record explicit task-boundary decisions. Supply expectedAttached (current sequence or null); legacy sequence is accepted. Deprecated pause/resume inputs never mutate state. Keep lifecycle transitions separate from dependent project edits and shell calls.",
		promptGuidelines: ["Use plan_task to establish concise task identity once. Later updates require a user-driven material change to the deliverable/defining constraints, an explicit rename, or correction of mistaken identity. Do not log progress, findings, proposed/rejected techniques, implementation adjustments, or message paraphrases. Use include/discussion only for explicit task-boundary decisions. In Plan mode, create a task when the user requests a planning deliverable or accepts a concrete proposed change in the planning conversation—not for informational agreement or discussion alone. Start a new plan only when no current plan exists, using expectedAttached: null, title, and scope; await the returned canonical path before saving the plan and requesting implementation approval through plan_exit. If the user explicitly abandons the current plan, call plan_task abandon with its expected attachment and a concise reason; otherwise complete the current plan before starting another."],
		parameters: Type.Object({
			action: Type.String({ enum: ["list", "pause", "resume", "update", "include", "discussion", "new", "abandon"] }),
			sequence: Type.Optional(Type.Integer({ minimum: 0 })),
			expectedAttached: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
			targetSequence: Type.Optional(Type.Integer({ minimum: 0 })),
			title: Type.Optional(Type.String({ maxLength: 160 })),
			scope: Type.Optional(Type.String({ maxLength: 4000 })),
			topic: Type.Optional(Type.String({ maxLength: 1000 })),
			reason: Type.Optional(Type.String({ maxLength: 1000 })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Task update cancelled");
			const action = params.action;
			plans.assertUsable();
			if (action === "list") return taskResult("list", "");
			const expected = params.expectedAttached !== undefined ? params.expectedAttached : params.sequence;
			if (expected === undefined || expected !== plans.collection.attached) throw new Error(`Stale task sequence/attachment: expected ${expected === undefined ? "not supplied" : expected === null ? "none" : expected}; actual ${plans.collection.attached ?? "none"}${plans.collection.attached !== null ? ` (${plans.plan.task?.title ?? "empty reservation"})` : ""}. Reconsider the requested action using this current plan.`);
			if (action === "pause" || action === "resume") throw new Error("Plan pause/resume is no longer supported. Complete or explicitly abandon the current plan before starting another.");
			if (action === "abandon") {
				if (!plans.attached) throw new Error("No current plan to abandon");
				if (!params.reason?.trim()) throw new Error("Abandoning a plan requires a concise reason based on explicit user direction");
				return taskResult("abandon", abandonCurrentPlan(params.reason, ctx));
			}
			if (!["update", "include", "discussion", "new"].includes(action)) throw new Error("Unknown task action");
			if (action === "new" && (runMode ?? selectedMode) !== "plan") throw new Error("New plans require Plan mode");
			if (action === "new" && plans.attached) throw new Error("Complete or explicitly abandon the current plan before starting another");
			if (action !== "new" && plans.collection.attached === null) throw new Error("No current plan; start one before changing task metadata");
			const existing = action === "new" ? undefined : plans.plan.task;
			const title = cleanTaskTitle(params.title ?? existing?.title ?? "");
			const scope = (params.scope ?? existing?.scope ?? "").trim();
			if (!title || !scope) throw new Error("A task requires a title and scope");
			if ((action === "include" || action === "discussion") && !params.topic?.trim()) throw new Error("A boundary decision requires a topic");
			if (action === "include" && !params.scope?.trim()) throw new Error("Include requires the complete user-approved scope");
			if (action === "discussion" && !existing) throw new Error("Establish the active task before recording a discussion decision");
			const decisions = [...(existing?.decisions ?? [])];
			if (action === "include" || action === "discussion") {
				const topic = params.topic!.trim();
				const index = decisions.findIndex((d) => d.topic.toLowerCase() === topic.toLowerCase());
				const decision = { topic, outcome: action as "include" | "discussion" };
				if (index >= 0) decisions[index] = decision;
				else decisions.push(decision);
			}
			const task = { title: action === "discussion" ? existing!.title : title, scope: action === "discussion" ? existing!.scope : scope, decisions };
			const changed = action === "new" || JSON.stringify(task) !== JSON.stringify(plans.plan.task);
			if (action === "new") startNewPlan(ctx, task);
			else if (changed) {
				plans.updateTask(task);
				persist();
				composer.update(ctx);
			}
			return taskResult(action, task.title, changed);
		},
		renderCall: statusCall("Updating plan task…"),
		renderResult(result, { expanded, isPartial }, theme, context) {
			const status = pendingOrError(result, { isPartial }, theme, context, "Updating plan task…", "Plan task update failed");
			if (status) return status;
			const details = result.details as { attached?: number | null; planPath?: string; fileState?: string; plans?: Array<{ sequence: number; title: string; path: string; fileState: string; outcome?: PlanOutcome }> } | undefined;
			let text = resultText(result);
			if (expanded && !context.isError && details) {
				text += `\nAttachment: ${details.attached ?? "none"}${details.planPath && !details.plans?.length ? `\n${details.planPath} (${details.fileState})` : ""}`;
				for (const item of details.plans ?? []) text += `\n${item.sequence}: ${item.title}\n${item.path} (${item.fileState})${item.outcome ? `\n${item.outcome.reason}${item.outcome.userAction ? `\nUser action: ${item.outcome.userAction}` : ""}` : ""}`;
			}
			return new Text(theme.fg(context.isError ? "error" : "muted", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_finish",
		label: "Record Plan Outcome",
		description: "Before a final planned-work summary, record an unfinished Build outcome. For completed work with all required verification passed, use plan_complete instead. awaiting_validation requires an essential userAction and keeps the plan attached and visibly open until the user reports success or explicitly directs completion; optional feedback is not a blocker. During step execution it pauses mutation authority while preserving the active step. blocked, waiting_for_input, and still_working also keep the current plan unfinished. Never use this to imply tests passed or to complete steps.",
		parameters: Type.Object({
			expectedAttached: Type.Integer({ minimum: 0 }),
			outcome: Type.String({ enum: ["awaiting_validation", "blocked", "waiting_for_input", "still_working"] }),
			reason: Type.String({ minLength: 1, maxLength: 2000 }),
			userAction: Type.Optional(Type.String({ maxLength: 2000 })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			plans.assertUsable();
			if ((runMode ?? selectedMode) !== "build") throw new Error("plan_finish requires Build mode");
			if (plans.collection.attached === null || params.expectedAttached !== plans.collection.attached) throw new Error("Stale attachment; reconsider the outcome against the current unfinished plan");
			if (!["awaiting_validation", "blocked", "waiting_for_input", "still_working"].includes(params.outcome) || !params.reason.trim()) throw new Error("A valid outcome and explanation are required");
			if (params.outcome === "awaiting_validation" && !params.userAction?.trim()) throw new Error("Essential user validation requires a concrete userAction");
			const sequence = plans.collection.attached;
			const title = plans.plan.task?.title ?? `Plan ${sequence}`;
			const file = currentPlanPath();
			if (params.outcome === "awaiting_validation" && plans.execution) {
				if (!activePlanStep(plans.execution)) throw new Error("Only an active implementation step can await essential validation");
				if (plans.execution.status === "running") plans.updateExecution(pausePlanExecution(plans.execution));
			}
			const outcome = { kind: params.outcome as PlanOutcome["kind"], reason: params.reason.trim(), ...(params.userAction?.trim() ? { userAction: params.userAction.trim() } : {}) };
			plans.outcome(outcome);
			if (reconciliation) reconciliation.handled = true;
			syncAttachment(ctx);
			const text = params.outcome === "awaiting_validation"
				? `${plans.execution ? "This step's implementation" : "Implementation"} is finished, but this plan remains open: ${title}\nWaiting for your validation before marking it complete.\n\nRequired validation:\n${outcome.userAction}`
				: `${title}: ${params.outcome.replaceAll("_", " ")}.`;
			return { content: [{ type: "text", text }], details: { sequence, title, planPath: file, fileState: savedPlanState, outcome, attached: plans.collection.attached } };
		},
		renderCall: statusCall("Recording plan outcome…"),
		renderResult(result, options, theme, context) {
			const status = pendingOrError(result, options, theme, context, "Recording plan outcome…", "Recording plan outcome failed");
			if (status) return status;
			let text = resultText(result) || "No outcome available";
			const details = result.details as { planPath?: string; fileState?: string; outcome?: PlanOutcome } | undefined;
			if (options.expanded && details) {
				if (details.planPath) text += `\n${details.planPath} (${details.fileState})`;
				for (const extra of [details.outcome?.reason, details.outcome?.userAction]) {
					if (extra && !text.includes(extra)) text += `\n${extra}`;
				}
			}
			return new Text(theme.fg(context.isError ? "error" : "muted", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_complete",
		label: "Complete Plan",
		description: "Mark the current saved plan complete only after its implementation and required verification are finished, or the user explicitly confirms completion or waives pending validation. Do not call for partial work, errors, or merely approving a plan. Preserves the plan file; the next planning task gets a new file.",
		promptGuidelines: ["Before announcing finished planned implementation, call plan_complete when all required work and verification have passed. Do not wait for ceremonial user acceptance or optional feedback. Use plan_finish for unfinished outcomes; never infer completion solely from a turn ending."],
		parameters: EMPTY_PARAMETERS,
		executionMode: "sequential",
		async execute() {
			const planPath = currentPlanPath();
			completeCurrentPlan();
			return {
				content: [{ type: "text", text: "Plan complete." }],
				details: { planPath, completed: true },
			};
		},
		renderCall: statusCall("Completing plan…"),
		renderResult(result, options, theme, context) {
			const status = pendingOrError(result, options, theme, context, "Completing plan…", "Plan completion failed");
			if (status) return status;
			const details = result.details as { completed?: boolean; planPath?: string } | undefined;
			return new Text(theme.fg(details?.completed ? "success" : "muted", details?.completed ? `Plan complete.${options.expanded && details.planPath ? `\n${details.planPath}` : ""}` : "Completion status unavailable"), 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_enter",
		label: "Enter Plan Mode",
		description: PLAN_ENTER_DESCRIPTION,
		parameters: EMPTY_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			await selectMode("plan", ctx, "tool");
			return {
				content: [{ type: "text", text: "Switched to Plan mode." }],
				details: { mode: "plan", planPath: currentPlanPath() },
			};
		},
		renderCall: statusCall("Switching to Plan mode…"),
		renderResult(result, options, theme, context) {
			const status = pendingOrError(result, options, theme, context, "Switching to Plan mode…", "Plan mode transition failed");
			if (status) return status;
			const details = result.details as { mode?: string; planPath?: string } | undefined;
			return new Text(theme.fg(details?.mode === "plan" ? "success" : "muted", details?.mode === "plan" ? `Switched to Plan mode${options.expanded && details.planPath ? `\n${details.planPath}` : ""}` : "Mode transition status unavailable"), 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_step_control",
		label: "Control Plan Execution",
		description: `Use this tool to translate the user's natural-language instructions into one step-execution action. Available actions: start a ready step, complete a clearly finished ready step or a paused active step whose required user validation explicitly succeeded, skip a ready step, revise an unimplemented instruction, pause/resume or cancel execution, or hide/show the visual plan panel. A successful validation report authorizes only completion; a failed report may resume the same active step for remediation. Do not advance based on hypothetical, uncertain, or unrelated conversation.`,
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("start"),
				Type.Literal("complete"),
				Type.Literal("skip"),
				Type.Literal("revise"),
				Type.Literal("pause"),
				Type.Literal("resume"),
				Type.Literal("cancel"),
				Type.Literal("hide"),
				Type.Literal("show"),
			]),
			step: Type.Optional(Type.Number({ description: "One-based step number; defaults to the current ready step", minimum: 1 })),
			instruction: Type.Optional(Type.String({ description: "Replacement instruction required for revise" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			plans.assertUsable();
			if ((runMode ?? selectedMode) !== "build") throw new Error("Step control requires Build mode");
			if (!plans.execution) throw new Error("No step-by-step plan is active");
			const target = params.step === undefined
				? params.action === "complete" && plans.plan.outcome?.kind === "awaiting_validation"
					? activePlanStep(plans.execution)
					: plans.execution.steps.find((step) => step.status === "ready")
				: plans.execution.steps[Math.floor(params.step) - 1];
			const finish = (message: string, extraDetails?: { planCompleted?: boolean }) => ({
				content: [{ type: "text" as const, text: message }],
				details: { action: params.action, stepId: target?.id, ...extraDetails },
				terminate: true,
			});

			if (params.action === "cancel") {
				cancelPlanExecution();
				return finish("Step-by-step execution was cancelled. The panel and execution guards were removed; the saved plan file remains available.");
			}
			if (params.action === "hide" || params.action === "show") {
				if (params.action === "show" && composer.reduced) {
					throw new Error("The visual plan panel is disabled because another extension owns Pi's optional editor or fullscreen layout UI");
				}
				updateExecution({ ...plans.execution, panelVisible: params.action === "show" });
				return finish(`The visual plan panel is now ${params.action === "show" ? "visible" : "hidden"}. Progress is unchanged.`);
			}
			if (plans.execution.status === "completed") throw new Error("The plan is already complete");
			if (params.action === "pause" || params.action === "resume") {
				if ((params.action === "pause") === (plans.execution.status === "paused")) return finish(`Plan execution is already ${params.action === "pause" ? "paused" : "running"}.`);
				if (params.action === "resume" && plans.plan.outcome?.kind === "awaiting_validation") plans.outcome(undefined);
				updateExecution(pausePlanExecution(plans.execution));
				return finish(`Plan execution is now ${params.action === "pause" ? "paused" : "running"}.`);
			}
			if (!target) throw new Error("No matching plan step is available for that action");
			if (params.action === "start") {
				if (plans.execution.status === "paused") throw new Error("Resume plan execution before starting a step");
				updateExecution(startPlanStep(plans.execution, target.id));
				pi.sendUserMessage(`Implement plan step ${plans.execution.steps.findIndex((step) => step.id === target.id) + 1}: ${target.text}`, { deliverAs: "followUp" });
				return finish("The requested step is approved. Its implementation is starting in a follow-up turn.");
			}
			if (params.action === "complete") {
				const completion = completeExecutionStep(target.id);
				return finish(
					completion ?? "The step was marked complete. The next step is ready and awaits user instruction.",
					{ planCompleted: completion !== undefined },
				);
			}
			if (params.action === "skip") {
				const completion = applyExecutionTransition(skipPlanStep(plans.execution, target.id));
				return finish(
					completion ?? "The step was skipped. The next step awaits user instruction.",
					{ planCompleted: completion !== undefined },
				);
			}
			if (!params.instruction?.trim()) throw new Error("Revising a step requires a replacement instruction");
			// Validate status before touching bytes, and serialize with built-in file mutations.
			revisePlanStep(plans.execution, target.id, params.instruction);
			await withFileMutationQueue(currentPlanPath(), async () => {
				const plan = await fs.promises.readFile(currentPlanPath(), "utf8");
				const expectedLine = plans.execution!.planMarkdown.replace(/\r\n?/g, "\n").split("\n")[target.sourceLine];
				if (plan.replace(/\r\n?/g, "\n").split("\n")[target.sourceLine] !== expectedLine) throw new Error("The saved plan changed; the step cannot be revised safely");
				const updatedPlan = updatePlanStepInstruction(plan, target.sourceLine, params.instruction!, target.text);
				const next = revisePlanStep(plans.execution!, target.id, params.instruction!, updatedPlan);
				await fs.promises.writeFile(currentPlanPath(), updatedPlan, "utf8");
				updateExecution(next);
			});
			return finish("The plan step instruction was revised and is awaiting user approval.");
		},
		renderCall: statusCall("Updating step…"),
		renderResult(result, options, theme, context) {
			return renderStepResult(result, options, theme, context, "Updating step…", "Step status unavailable");
		},
	});

	pi.registerTool({
		name: "plan_step_complete",
		label: "Complete Plan Step",
		description: PLAN_STEP_COMPLETE_DESCRIPTION,
		parameters: Type.Object({
			summary: Type.String({ description: "Concise summary of what was implemented and verified" }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			plans.assertUsable();
			const step = completablePlanStep();
			if (!plans.execution || !step) throw new Error("No plan step is currently active");
			const completion = completeExecutionStep(step.id, params.summary);
			return {
				content: [{ type: "text", text: completion ?? "The step was completed. The next step is ready and awaits user instruction." }],
				details: { stepId: step.id, completed: true, planCompleted: completion !== undefined },
				terminate: true,
			};
		},
		renderCall: statusCall("Completing step…"),
		renderResult(result, options, theme, context) {
			return renderStepResult(result, options, theme, context, "Completing step…", "Step completion status unavailable");
		},
	});

	pi.registerTool({
		name: "plan_exit",
		renderShell: "self",
		label: "Exit Plan Mode",
		description: PLAN_EXIT_DESCRIPTION,
		promptSnippet: "Display the saved plan and request user approval",
		promptGuidelines: ["Call plan_exit after finalizing the saved plan when the user asks to show, review, or approve it."],
		parameters: EMPTY_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			plans.assertUsable();
			if (!ctx.hasUI) throw new Error("plan_exit requires an interactive TUI or RPC client");
			if (plans.collection.attached === null) throw new Error("No attached plan to approve");
			let plan: string;
			try {
				plan = await fs.promises.readFile(currentPlanPath(), "utf8");
			} catch (error: unknown) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`Cannot request plan approval because the plan file could not be read: ${detail}`);
			}
			if (!plan.trim()) throw new Error("Cannot request plan approval because the plan file is empty");
			refreshSavedPlanTitle();
			pi.appendEntry(PLAN_REVIEW_ENTRY_TYPE, { plan, planPath: currentPlanPath() });
			const displayPath = shorten(currentPlanPath(), ctx.cwd);
			composer.conflict(ctx);
			let stepExecution: PlanExecutionState | undefined;
			let stepsError: string | undefined;
			const panelAvailable = composer.panelAvailable;
			if (panelAvailable) {
				try {
					stepExecution = createPlanExecution(plan);
				} catch (error: unknown) {
					stepsError = error instanceof Error ? error.message : String(error);
				}
			}
			const choices = [
				PLAN_EXIT_APPROVE_CHOICE,
				PLAN_EXIT_FRESH_CHOICE,
				...(stepExecution ? [PLAN_STEP_CHOICE] : []),
				PLAN_EXIT_STAY_CHOICE,
			];
			const selection = normalizePlanExitChoice(await ctx.ui.select(
				`Build Agent: Plan at ${displayPath} is complete. What would you like to do?`,
				choices,
			));
			const action = selection.choice === PLAN_STEP_CHOICE && stepExecution
				? "step-by-step"
				: classifyPlanExitChoice(selection.choice);
			if (action !== "implement-fresh") {
				const message = PLAN_ACTION_ANNOUNCEMENTS[action];
				modeNotices.append(message, _toolCallId);
				if (ctx.mode === "rpc") ctx.ui.notify(message, "info");
			}
			if (selection.choice === PLAN_STEP_CHOICE && stepExecution) {
				freshImplementationRequest = undefined;
				plans.updateExecution(stepExecution);
				await selectMode("build", ctx, "tool");
				composer.ensurePanel();
				pi.appendEntry(PLAN_STEP_GUIDANCE_ENTRY_TYPE);
				return {
					content: [{ type: "text", text: "Step-by-step execution ready. Awaiting your instruction." }],
					details: { approved: true, action: "step-by-step", mode: "build", planPath: currentPlanPath() },
					terminate: true,
				};
			}
			if (panelAvailable && !stepExecution && stepsError) {
				ctx.ui.notify(`Step-by-step execution is unavailable: ${stepsError}.`, "warning");
			} else if (composer.capable && !panelAvailable) {
				ctx.ui.notify(`Step-by-step execution requires a terminal at least ${PANEL_MIN_TERMINAL_WIDTH} columns wide.`, "warning");
			}
			const decision = classifyPlanExitChoice(selection.choice);
			if (decision === "stay") {
				freshImplementationRequest = undefined;
				return buildPlanExitStayResult(currentPlanPath(), selection.cancelled);
			}
			if (decision === "implement-fresh") {
				handoffSequence = plans.collection.attached ?? undefined;
				freshImplementationRequest = handoffSnapshot(buildFreshImplementationRequest(
					plan,
					ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
					pi.getThinkingLevel(),
				), plans.plan.task, toolsBeforeModes);
				pi.sendUserMessage("/build-fresh", {
					deliverAs: "followUp",
					expandPromptTemplates: true,
				});
				return buildPlanExitFreshResult(currentPlanPath());
			}
			freshImplementationRequest = undefined;
			await selectMode("build", ctx, "tool");
			armReconciliation(ctx);
			return {
				content: [
					{
						type: "text",
						text: "Plan approved; switched to Build mode. Implement the approved plan now within its authorization boundaries. Continue actionable work and required verification; acknowledgment or initial inspection alone is not completion. Stop for genuine blockers, essential user input, or interruption. Deployment and restarts still require any separately specified approval.",
					},
				],
				details: { approved: true, mode: "build", planPath: currentPlanPath() },
			};
		},
		renderCall: statusCall("Processing plan approval…"),
		renderResult(result, options, theme, context) {
			const status = pendingOrError(result, options, theme, context, "Processing plan approval…", "Plan approval failed");
			if (status) return status;
			const details = result.details as { approved?: boolean; action?: string } | undefined;
			if (!options.expanded && typeof details?.approved === "boolean" && modeNotices.has(context)) return new Container();
			if (details?.action === "step-by-step" && !context.isError) {
				return new Text(theme.fg("success", "Step-by-step execution ready"), 0, 0);
			}
			if (details?.action === "implement-fresh" && !context.isError) {
				return new Text(
					theme.fg("success", "Clean-session implementation selected — starting automatically."),
					0,
					0,
				);
			}
			if (details?.approved === true && !context.isError) {
				return new Text(theme.fg("success", "Plan approved; switched to Build mode"), 0, 0);
			}
			return new Text(theme.fg("warning", details?.approved === false ? "Remaining in Plan mode" : "Plan approval status unavailable"), 0, 0);
		},
	});

	// One initialization boundary for new runs, changed attachments, and restoration.
	// Restored consumed markers are deliberately ineligible until new user work.
	function resetReconciliation(sequence: number | null, sessionId: string, consumed = false): void {
		activeReconciliationId = undefined;
		reconciliationFollowUp = false;
		reconciliation = sequence === null ? undefined : {
			sequence, sessionId, consumed, eligible: false, handled: false, failed: false, terminal: false,
		};
	}

	function beginReconciliation(ctx: ExtensionContext): void {
		if (reconciliationFollowUp) reconciliationFollowUp = false;
		else resetReconciliation(plans.collection.attached, ctx.sessionManager.getSessionId()!);
	}

	function armReconciliation(ctx: ExtensionContext): void {
		if ((runMode ?? selectedMode) !== "build" || plans.collection.attached === null || plans.execution || inspectPlanFile(currentPlanPath()) !== "saved") return;
		if (!reconciliation || reconciliation.sequence !== plans.collection.attached || reconciliation.sessionId !== ctx.sessionManager.getSessionId()) {
			resetReconciliation(plans.collection.attached, ctx.sessionManager.getSessionId()!);
		}
		if (reconciliation!.consumed || reconciliation!.handled) return;
		reconciliation!.eligible = true;
		// Keep essential validation/outcome facts until an explicit outcome transition.
	}

	pi.on("input", (event) => {
		// Some Pi continuation paths bypass before_agent_start. A real new user
		// request must not inherit the previous hidden follow-up's consumed flag.
		if (event.source !== "extension") reconciliationFollowUp = false;
	});

	pi.on("agent_end", (event) => {
		if (!reconciliation) return;
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		reconciliation.terminal = last?.role === "assistant" && last.stopReason === "stop";
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) reconciliation.failed = true;
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError && reconciliation) reconciliation.failed = true;
		if (!event.isError && (event.toolName === "edit" || event.toolName === "write") && !plans.collection.records.some((r) => isAllowedPlanMutation(ctx.cwd, (event.input as { path?: unknown }).path, planPathFor(r.plan.sequence, ctx)))) armReconciliation(ctx);
		if (!event.isError && (event.toolName === "write" || event.toolName === "edit") && isAllowedPlanMutation(ctx.cwd, (event.input as { path?: unknown }).path, currentPlanPath())) {
			refreshSavedPlanTitle();
			applyTools(runMode ?? selectedMode);
			composer.update(ctx);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const effectiveMode = runMode ?? selectedMode;
		if (plans.error && (MANAGED_TOOLS.has(event.toolName) && event.toolName !== "question" && event.toolName !== "plan_enter" || ["edit", "write", "bash", "powershell"].includes(event.toolName))) return { block: true, reason: `Plan state unavailable: ${plans.error}. Restore usable state before mutations.` };
		if (["edit", "write", "bash", "powershell", "plan_complete", "plan_finish", "plan_step_control", "plan_step_complete", "plan_exit"].includes(event.toolName)) {
			const latestAssistant = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (latestAssistant?.type === "message" && latestAssistant.message.role === "assistant" && latestAssistant.message.content.some((part) => part.type === "toolCall" && part.name === "plan_task" && !["list", "pause", "resume"].includes((part.arguments as { action?: string })?.action ?? ""))) {
				return { block: true, reason: "Await plan_task in a separate tool batch before dependent edits, shell commands, or execution actions." };
			}
		}
		if (effectiveMode === "build" && (event.toolName === "edit" || event.toolName === "write")) {
			const inputPath = (event.input as { path?: unknown }).path;
			if (isAllowedPlanMutation(ctx.cwd, inputPath, currentPlanPath()) || plans.collection.records.some((r) => isAllowedPlanMutation(ctx.cwd, inputPath, planPathFor(r.plan.sequence, ctx)))) {
				return {
					block: true,
					reason: "Current and historical plan files are read-only in Build mode. Do not add completion markers or otherwise update their steps; report completion through plan_step_complete during step execution or plan_complete after normal implementation and verification.",
				};
			}
		}
		if (effectiveMode === "build" && plans.execution && plans.execution.status !== "completed" && !executablePlanStep(plans.execution) && (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash" || event.toolName === "powershell")) {
			return {
				block: true,
				reason: "Step-by-step execution is waiting for an explicit natural-language instruction from the user; no step is approved for project mutations.",
			};
		}
		if (effectiveMode !== "plan" || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const inputPath = (event.input as { path?: unknown }).path;
		if (plans.collection.attached !== null && isAllowedPlanMutation(ctx.cwd, inputPath, currentPlanPath())) return;
		return {
			block: true,
			reason: `Plan mode only permits edit/write access to the plan file: ${currentPlanPath()}`,
		};
	});

	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => !isObsoletePlanContext(message, activeReconciliationId));
		const content = buildPlanContext(runMode ?? selectedMode, plans.collection, { path: currentPlanPath(), state: savedPlanState }, plans.error);
		if (content) {
			// Pi converts custom messages to user-role messages. Keep operational context
			// before the actual request, never after its assistant/tool exchange.
			const userIndex = messages.findLastIndex((message) => message.role === "user");
			messages.splice(Math.max(0, userIndex), 0, {
				role: "custom", customType: TASK_CONTEXT_TYPE,
				content: `Background operational context, not a new user request. Do not acknowledge this block; follow the actual user request within these constraints.\n\n${content}`,
				display: false, timestamp: Date.now(),
			});
		}
		return { messages };
	});

	pi.on("before_agent_start", (_event, ctx) => {
		const announceFresh = pendingFreshAnnouncement;
		if (announceFresh) {
			pendingFreshAnnouncement = false;
			persist();
		}
		beginReconciliation(ctx);
		composer.conflict(ctx);
		runMode = selectedMode;
		if (announceFresh) armReconciliation(ctx);
		refreshSavedPlanTitle();
		applyTools(runMode);
		if (announceFresh) {
			const content = PLAN_ACTION_ANNOUNCEMENTS["implement-fresh"];
			if (ctx.mode === "rpc") ctx.ui.notify(content, "info");
			// Returned messages follow the full user handoff in live and restored transcripts.
			return { message: { customType: FRESH_ANNOUNCEMENT_MESSAGE_TYPE, content, display: true } };
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		activeReconciliationId = undefined;
		runMode = undefined;
		applyTools(selectedMode);
		composer.update(ctx);
		if (plans.execution && plans.execution.status !== "completed") composer.ensurePanel();
		if (shouldReconcileCompletion(reconciliation, plans.collection.attached, selectedMode, ctx.sessionManager.getSessionId()!, !!plans.execution, ctx.isIdle(), ctx.hasPendingMessages())) {
			reconciliation!.consumed = true;
			reconciliationFollowUp = true;
			persist();
			activeReconciliationId = randomUUID();
			pi.sendMessage({ customType: RECONCILIATION_CONTEXT_TYPE, details: { reconciliationId: activeReconciliationId }, display: false, content: "Reconcile the attached plan's outcome before ending. This is a single bookkeeping reminder, not permission for more implementation or verification. If all approved work and required checks passed, call plan_complete. If essential user-only validation remains, call plan_finish awaiting_validation with the exact user action. Otherwise record blocked, waiting_for_input, or still_working with a reason. Optional feedback does not block completion. Do not infer success from this reminder and do not repeat tests merely to close the plan." }, { triggerTurn: true, deliverAs: "followUp" });
		}
	});

	pi.on("model_select", (_event, ctx) => { currentContext = ctx; composer.update(ctx); });
	pi.on("thinking_level_select", (_event, ctx) => composer.update(ctx));
	pi.on("session_compact", (_event, ctx) => { refreshSavedPlanTitle(); applyTools(runMode ?? selectedMode); composer.update(ctx); });

	pi.on("message_start", (event) => {
		if (event.message.role !== "user") return;
		activeReconciliationId = undefined;
		const text = displayUserMessageText(extractUserMessageText(event.message.content));
		if (text) userMessageRail.addMessage(text, runMode ?? selectedMode);
	});

	function restorePlanState(raw: LegacyState | undefined, ctx: ExtensionContext, sourceSessionId?: string): void {
		const consumed = raw?.reconciliation as { sequence?: number; sessionId?: string; consumed?: boolean } | undefined;
		if (consumed?.consumed && Number.isSafeInteger(consumed.sequence) && typeof consumed.sessionId === "string") {
			resetReconciliation(consumed.sequence!, consumed.sessionId, true);
		} else resetReconciliation(null, ctx.sessionManager.getSessionId()!);
		const inspected = new Map<number, typeof savedPlanState>();
		const inspect = (sequence: number) => {
			if (!inspected.has(sequence)) inspected.set(sequence, inspectPlanFile(planPathFor(sequence, ctx)));
			return inspected.get(sequence)!;
		};
		try {
			plans.restore(restoreCollection(raw, inspect, sourceSessionId
				? (sequence) => inspectPlanFile(makePlanPath(path.join(getAgentDir(), "plans"), sourceSessionId, sequence)) : undefined), allocationHighWater(ctx.sessionManager.getEntries()));
		} catch (error) {
			plans.collection = { records: [], attached: null, counter: 0 };
			plans.error = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Plan state unavailable: ${plans.error}. Plan mutations are disabled.`, "error");
		}
		refreshSavedPlanTitle(plans.collection.attached === null ? "absent" : inspect(plans.collection.attached));
		lastSnapshot = JSON.stringify(stateData());
	}

	pi.on("session_tree", (_event, ctx) => {
		const raw = latestPlanState(ctx.sessionManager.getBranch());
		composer.removePanel();
		freshImplementationRequest = undefined;
		handoffSequence = undefined;
		currentContext = ctx;
		selectedMode = decodeModeState(raw)?.selectedMode ?? "build";
		pendingFreshAnnouncement = raw?.pendingFreshAnnouncement === true;
		restorePlanState(raw, ctx);
		runMode = undefined;
		restoreUserMessageRails(ctx.sessionManager.getBranch());
		applyTools(selectedMode);
		composer.update(ctx);
		if (plans.execution) composer.ensurePanel();
	});

	pi.on("session_start", async (event, ctx) => {
		userMessageRail.activate();
		currentContext = ctx;
		if (shortcutConfigWarning && !shortcutConfigWarningShown && ctx.hasUI) {
			shortcutConfigWarningShown = true;
			ctx.ui.notify(
				`Invalid Pi Plan Build configuration at ${shortcutConfigPath}: ${shortcutConfigWarning}. Defaults were used for invalid settings.`,
				"warning",
			);
		}
		const raw = latestPlanState(ctx.sessionManager.getBranch());
		const decoded = decodeModeState(raw);
		pendingFreshAnnouncement = raw?.pendingFreshAnnouncement === true;
		selectedMode = decoded?.selectedMode ?? (pi.getFlag("plan") === true ? "plan" : "build");
		restoreUserMessageRails(ctx.sessionManager.getBranch());
		toolsBeforeModes = Array.isArray(raw?.toolsBeforeModes)
			? raw.toolsBeforeModes.filter((name): name is string => typeof name === "string" && !MANAGED_TOOLS.has(name))
			: pi.getActiveTools().filter((name) => !MANAGED_TOOLS.has(name));
		const plansDir = path.join(getAgentDir(), "plans");
		restorePlanState(raw, ctx, event.reason === "fork" ? raw?.planSessionId : undefined);
		runMode = undefined;
		let attachedFileChanged = false;
		if (event.reason === "fork" && typeof raw?.planSessionId === "string" && raw.planSessionId !== ctx.sessionManager.getSessionId()) {
			for (const { plan } of plans.collection.records) {
				const sourcePath = makePlanPath(plansDir, raw.planSessionId, plan.sequence);
				const destination = planPathFor(plan.sequence, ctx);
				if (fs.existsSync(sourcePath) && !fs.existsSync(destination)) {
					await ensurePlanDirectory();
					await fs.promises.copyFile(sourcePath, destination, fs.constants.COPYFILE_EXCL);
					if (plan.sequence === plans.collection.attached) attachedFileChanged = true;
				}
			}
		}
		if (plans.execution) await ensurePlanDirectory();
		if (plans.execution && !attachedFileChanged && savedPlanState === "absent") {
			await fs.promises.writeFile(currentPlanPath(), plans.execution.planMarkdown, { encoding: "utf8", flag: "wx" });
			attachedFileChanged = true;
		}
		if (attachedFileChanged) refreshSavedPlanTitle();
		if (raw?.version !== STATE_VERSION && (plans.collection.records.length || plans.collection.counter)) {
			lastSnapshot = "";
			persist(); // One meaningful migration, including the fork-source session identity.
		}
		applyTools(selectedMode);
		composer.mount(ctx, event.reason === "startup" ? [] : extractPromptHistory(ctx.sessionManager.getBranch()));
		composer.update(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeReconciliationId = undefined;
		userMessageRail.deactivate();
		composer.dispose(ctx);
		currentContext = undefined;
	});
}
