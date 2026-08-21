import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomEditor, getAgentDir, getMarkdownTheme, type EntryRenderer, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HStack, Key, Markdown, matchesKey, Text, truncateToWidth, visibleWidth, isViewportTUI, type Component, type TUI, type ViewportTUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerQuestionTool } from "./question-ui.ts";
import {
	buildPlanReminder,
	buildPlanStepReminder,
	buildPlanStepWaitingReminder,
	PLAN_ENTER_DESCRIPTION,
	PLAN_EXIT_DESCRIPTION,
	PLAN_STEP_COMPLETE_DESCRIPTION,
	PLAN_TO_BUILD_REMINDER,
} from "./prompts.ts";
import {
	acceptPlanStep,
	activePlanStep,
	completePlanStep,
	createPlanExecution,
	decodePlanExecution,
	pausePlanExecution,
	requestPlanStepCorrections,
	revisePlanStep,
	skipPlanStep,
	startPlanStep,
	submitPlanStepForReview,
	updatePlanChecklistStep,
	type PlanExecutionState,
} from "./plan-execution.ts";
import { PlanPanel } from "./plan-panel.ts";
import {
	applyManualSelection,
	buildFreshImplementationHandoff,
	buildFreshImplementationRequest,
	buildPlanExitFreshResult,
	buildPlanExitStayResult,
	buildPlanReviewMessage,
	classifyPlanExitChoice,
	type FreshImplementationRequest,
	decodeModeState,
	extractPromptHistory,
	formatFooterCwd,
	formatModeMetadata,
	formatModeRail,
	formatModeTopBorder,
	formatTokens,
	isAllowedPlanMutation,
	makePlanPath,
	nextMode,
	nextThinkingLevel,
	normalizePlanExitChoice,
	PLAN_EXIT_APPROVE_CHOICE,
	PLAN_EXIT_FRESH_CHOICE,
	PLAN_EXIT_STAY_ACKNOWLEDGEMENT,
	PLAN_EXIT_STAY_CHOICE,
	renderModeComposer,
	type Mode,
	unique,
} from "./utils.ts";

const STATE_TYPE = "pi-plan-build-state";
const LEGACY_STATE_TYPE = "opencode-modes-state";
const PLAN_REVIEW_ENTRY_TYPE = "pi-plan-build-review";
const LEGACY_PLAN_REVIEW_ENTRY_TYPE = "opencode-plan-review";
const MODE_NOTICE_ENTRY_TYPE = "pi-plan-build-notice";
const LEGACY_MODE_NOTICE_ENTRY_TYPE = "opencode-mode-notice";
const STATUS_KEY = "pi-plan-build-mode";
const PLAN_STEP_CHOICE = "Implement step by step";
const PANEL_WIDTH = 64;
const PANEL_MIN_TERMINAL_WIDTH = 132;
const MANAGED_TOOLS = new Set(["question", "plan_enter", "plan_exit", "plan_step_control", "plan_step_complete"]);
const MODE_ADDED_TOOLS = new Set([...MANAGED_TOOLS, "edit", "write"]);
const EMPTY_PARAMETERS = Type.Object({});

type PendingReminder = "plan" | "build" | undefined;
interface StoredState {
	version: 1;
	selectedMode: Mode;
	pendingReminder?: "plan" | "build";
	toolsBeforeModes?: string[];
	execution?: PlanExecutionState;
}

function shorten(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	const home = os.homedir();
	return filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}

export default function planBuildModes(pi: ExtensionAPI): void {
	let selectedMode: Mode = "build";
	let runMode: Mode | undefined;
	let pendingReminder: PendingReminder;
	let planPath = "";
	let toolsBeforeModes: string[] = [];
	let currentContext: ExtensionContext | undefined;
	let requestEditorRender: (() => void) | undefined;
	let freshImplementationRequest: FreshImplementationRequest | undefined;
	let execution: PlanExecutionState | undefined;
	let panel: PlanPanel | undefined;
	let panelTui: (TUI & Partial<ViewportTUI>) | undefined;
	let originalLayoutRoot: Component | undefined;
	let panelLayoutRoot: Component | undefined;
	let fullscreenPanelCapable = false;

	pi.registerFlag("plan", {
		description: "Start in Plan mode",
		type: "boolean",
		default: false,
	});

	registerQuestionTool(pi);
	const renderPlanReview: EntryRenderer<{ plan: string }> = (entry) => {
		const plan = typeof entry.data?.plan === "string" ? entry.data.plan : "Plan unavailable";
		return new Markdown(buildPlanReviewMessage(plan), 0, 0, getMarkdownTheme());
	};
	const renderModeNotice: EntryRenderer<{ message: string }> = (entry, _options, theme) => {
		const message = typeof entry.data?.message === "string" ? entry.data.message : "Plan mode unchanged.";
		return new Text(theme.fg("warning", message), 0, 0);
	};
	pi.registerEntryRenderer<{ plan: string }>(PLAN_REVIEW_ENTRY_TYPE, renderPlanReview);
	pi.registerEntryRenderer<{ plan: string }>(LEGACY_PLAN_REVIEW_ENTRY_TYPE, renderPlanReview);
	pi.registerEntryRenderer<{ message: string }>(MODE_NOTICE_ENTRY_TYPE, renderModeNotice);
	pi.registerEntryRenderer<{ message: string }>(LEGACY_MODE_NOTICE_ENTRY_TYPE, renderModeNotice);

	function stateData(): StoredState {
		return { version: 1, selectedMode, pendingReminder, toolsBeforeModes, ...(execution ? { execution } : {}) };
	}

	function persist(): void {
		pi.appendEntry(STATE_TYPE, stateData());
	}

	function updateExecution(next: PlanExecutionState): void {
		execution = next;
		panel?.setState(next);
		persist();
		panelTui?.requestRender();
	}

	function removePanelLayout(): void {
		if (panelLayoutRoot && panelTui && originalLayoutRoot) panelTui.setLayoutRoot?.(originalLayoutRoot);
		panelLayoutRoot = undefined;
		panel = undefined;
		panelTui?.requestRender();
	}

	function cancelPlanExecution(): void {
		execution = undefined;
		removePanelLayout();
		persist();
		applyTools("build");
	}

	function ensurePanelLayout(): boolean {
		if (!execution || !fullscreenPanelCapable || !panelTui || !originalLayoutRoot || !currentContext) return false;
		if (!panel) panel = new PlanPanel(execution, currentContext.ui.theme);
		else panel.setState(execution);
		if (!panelLayoutRoot) {
			panelLayoutRoot = new HStack([
				{ component: originalLayoutRoot, basis: 0, grow: 1, shrink: 1, minSize: 58 },
				{
					component: panel,
					basis: PANEL_WIDTH,
					grow: 0,
					shrink: 0,
					minSize: PANEL_WIDTH,
					maxSize: PANEL_WIDTH,
					visible: (viewport) => execution?.panelVisible !== false && viewport.width >= PANEL_MIN_TERMINAL_WIDTH,
				},
			]);
			panelTui.setLayoutRoot?.(panelLayoutRoot);
		}
		panelTui.requestRender();
		return true;
	}

	function updateModeIndicator(ctx: ExtensionContext): void {
		// Clear the legacy footer status; the mode is now rendered inside the editor.
		ctx.ui.setStatus(STATUS_KEY, undefined);
		requestEditorRender?.();
	}

	function discoverUnmanagedTools(): void {
		const additions = pi.getActiveTools().filter((name) => !MODE_ADDED_TOOLS.has(name) && !toolsBeforeModes.includes(name));
		toolsBeforeModes = unique([...toolsBeforeModes, ...additions]);
	}

	function applyTools(mode: Mode): void {
		discoverUnmanagedTools();
		const base = [...toolsBeforeModes];
		if (mode === "plan") {
			pi.setActiveTools(unique([...base, "edit", "write", "question", "plan_exit"]));
		} else {
			pi.setActiveTools(unique([
				...base,
				"question",
				"plan_enter",
				...(execution ? ["plan_step_control"] : []),
				...(activePlanStep(execution) ? ["plan_step_complete"] : []),
			]));
		}
	}

	async function ensurePlanDirectory(): Promise<void> {
		await fs.promises.mkdir(path.dirname(planPath), { recursive: true });
	}

	function describePlanFile(): string {
		return fs.existsSync(planPath)
			? `A plan file already exists at ${planPath}. Read it when relevant, but leave it unchanged while discussing or researching. Use the edit tool only when finalizing or explicitly revising the plan.`
			: `No plan file exists yet. When ready to finalize, create your plan at ${planPath} using the write tool.`;
	}

	async function selectMode(mode: Mode, ctx: ExtensionContext, source: "manual" | "tool"): Promise<void> {
		if (mode === selectedMode && (source === "manual" || mode === runMode)) return;
		const previous = selectedMode;
		if (mode === "plan") await ensurePlanDirectory();

		if (source === "manual") {
			const next = applyManualSelection(mode, runMode, ctx.isIdle());
			selectedMode = next.selectedMode;
			runMode = next.runMode;
			pendingReminder = previous === mode ? pendingReminder : mode;
			if (ctx.isIdle()) applyTools(mode);
		} else {
			selectedMode = mode;
			runMode = mode;
			pendingReminder = undefined;
			applyTools(mode);
		}
		updateModeIndicator(ctx);
		persist();
	}

	pi.registerCommand("plan", {
		description: "Switch to Plan mode",
		handler: async (_args, ctx) => selectMode("plan", ctx, "manual"),
	});
	pi.registerCommand("build", {
		description: "Switch to Build mode",
		handler: async (_args, ctx) => selectMode("build", ctx, "manual"),
	});
	pi.registerCommand("build-fresh", {
		description: "Start a clean linked session and implement the plan selected in plan_exit",
		handler: async (_args, ctx) => {
			const request = freshImplementationRequest;
			if (!request) {
				ctx.ui.notify("No fresh implementation is pending. Choose ‘Start fresh and implement’ from plan_exit first.", "warning");
				return;
			}
			if (selectedMode !== "plan") {
				freshImplementationRequest = undefined;
				ctx.ui.notify("Fresh implementation is no longer available because Plan mode is not active.", "warning");
				return;
			}
			if (ctx.mode === "print" || ctx.mode === "json") {
				throw new Error("Fresh implementation requires TUI or RPC mode");
			}
			if (!request.model) {
				ctx.ui.notify("Cannot start implementation because no model is selected.", "warning");
				return;
			}
			const currentModel = ctx.model;
			const implementationModel = ctx.modelRegistry.find(request.model.provider, request.model.id)
				?? (currentModel?.provider === request.model.provider && currentModel.id === request.model.id ? currentModel : undefined);
			if (!implementationModel) {
				ctx.ui.notify(`Cannot start implementation because ${request.model.provider}/${request.model.id} is unavailable.`, "warning");
				return;
			}
			try {
				const modelSelected = await pi.setModel(implementationModel);
				if (modelSelected === false) {
					ctx.ui.notify(`Cannot start implementation because no API key is available for ${request.model.provider}/${request.model.id}.`, "warning");
					return;
				}
				pi.setThinkingLevel(request.thinkingLevel);
			} catch (error: unknown) {
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Cannot start implementation with ${request.model.provider}/${request.model.id}: ${detail}`, "warning");
				return;
			}

			freshImplementationRequest = undefined;
			const parentSession = ctx.sessionManager.getSessionFile();
			const sourceTools = [...toolsBeforeModes];
			const handoff = buildFreshImplementationHandoff(request.plan);
			let destinationPlanPath = "";
			let setupError: string | undefined;
			let kickoffError: string | undefined;
			try {
				const result = await ctx.newSession({
					...(parentSession ? { parentSession } : {}),
					setup: async (sessionManager) => {
						try {
							destinationPlanPath = makePlanPath(
								path.join(getAgentDir(), "plans"),
								sessionManager.getSessionId(),
							);
							await fs.promises.mkdir(path.dirname(destinationPlanPath), { recursive: true });
							await fs.promises.writeFile(destinationPlanPath, request.plan, "utf8");
							sessionManager.appendModelChange(request.model.provider, request.model.id);
							sessionManager.appendThinkingLevelChange(request.thinkingLevel);
							sessionManager.appendCustomEntry(STATE_TYPE, {
								version: 1,
								selectedMode: "build",
								pendingReminder: "build",
								toolsBeforeModes: sourceTools,
							} satisfies StoredState);
						} catch (error: unknown) {
							setupError = error instanceof Error ? error.message : String(error);
						}
					},
					withSession: async (replacementCtx) => {
						if (setupError) {
							replacementCtx.ui.setEditorText(handoff);
							replacementCtx.ui.notify(
								`Fresh session opened, but setup failed: ${setupError}. The implementation request is in the editor.`,
								"error",
							);
							return;
						}
						try {
							await replacementCtx.sendUserMessage(handoff);
							replacementCtx.ui.notify(
								`Fresh implementation session started with plan ${shorten(destinationPlanPath, replacementCtx.cwd)}.`,
								"info",
							);
						} catch (error: unknown) {
							kickoffError = error instanceof Error ? error.message : String(error);
							replacementCtx.ui.setEditorText(handoff);
							replacementCtx.ui.notify(
								`Fresh session opened, but implementation did not start: ${kickoffError}. The request is in the editor.`,
								"error",
							);
						}
					},
				});
				if (result.cancelled) {
					freshImplementationRequest = request;
					ctx.ui.notify("Fresh implementation cancelled; the source plan remains available.", "info");
				}
			} catch (error: unknown) {
				freshImplementationRequest = request;
				const detail = error instanceof Error ? error.message : String(error);
				try {
					ctx.ui.notify(`Unable to start a fresh implementation session: ${detail}`, "error");
				} catch {
					// The source command context may be stale after partial session replacement.
				}
			}
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
				content: [{ type: "text", text: buildPlanReminder(describePlanFile()) }],
				details: { mode: "plan", planPath },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Enter Plan mode")), 0, 0);
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("success", "Switched to Plan mode"), 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_step_control",
		label: "Control Plan Execution",
		description: `Use this tool to translate the user's natural-language instructions into one step-by-step plan action. Available actions: start a ready step, complete a clearly finished ready or reviewed step, accept a reviewed step, request corrections, skip a ready step, revise an unimplemented instruction, pause/resume or cancel execution, or hide/show the visual plan panel. Interpret clear user intent semantically, including direct completion statements, but do not advance based on hypothetical, uncertain, or unrelated conversation.`,
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("start"),
				Type.Literal("complete"),
				Type.Literal("accept"),
				Type.Literal("correct"),
				Type.Literal("skip"),
				Type.Literal("revise"),
				Type.Literal("pause"),
				Type.Literal("resume"),
				Type.Literal("cancel"),
				Type.Literal("hide"),
				Type.Literal("show"),
			]),
			step: Type.Optional(Type.Number({ description: "One-based step number; defaults to the current ready/review step", minimum: 1 })),
			instruction: Type.Optional(Type.String({ description: "Replacement instruction required for revise" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (!execution) throw new Error("No step-by-step plan is active");
			const target = params.step === undefined
				? execution.steps.find((step) => step.status === "ready" || step.status === "review")
				: execution.steps[Math.floor(params.step) - 1];
			const finish = (message: string) => ({
				content: [{ type: "text" as const, text: message }],
				details: { action: params.action, stepId: target?.id },
				terminate: true,
			});

			if (params.action === "cancel") {
				cancelPlanExecution();
				return finish("Step-by-step execution was cancelled. The panel and execution guards were removed; the saved plan file remains available.");
			}
			if (params.action === "hide" || params.action === "show") {
				updateExecution({ ...execution, panelVisible: params.action === "show" });
				if (params.action === "show") ensurePanelLayout();
				return finish(`The visual plan panel is now ${params.action === "show" ? "visible" : "hidden"}. Progress is unchanged.`);
			}
			if (execution.status === "completed") throw new Error("The plan is complete; only hide or show actions remain available");
			if (params.action === "pause" || params.action === "resume") {
				if ((params.action === "pause") === (execution.status === "paused")) return finish(`Plan execution is already ${params.action === "pause" ? "paused" : "running"}.`);
				updateExecution(pausePlanExecution(execution));
				return finish(`Plan execution is now ${params.action === "pause" ? "paused" : "running"}.`);
			}
			if (!target) throw new Error("No matching plan step is available for that action");
			if (params.action === "start") {
				if (execution.status === "paused") throw new Error("Resume plan execution before starting a step");
				updateExecution(startPlanStep(execution, target.id));
				applyTools("build");
				pi.sendUserMessage(`Implement plan step ${execution.steps.findIndex((step) => step.id === target.id) + 1}: ${target.text}`, { deliverAs: "followUp" });
				return finish("The requested step is approved. Its implementation is starting in a follow-up turn.");
			}
			if (params.action === "complete") {
				updateExecution(completePlanStep(execution, target.id));
				return finish(execution.status === "completed" ? "The step was marked complete and the plan is complete." : "The step was marked complete. The next step is ready and awaits user instruction.");
			}
			if (params.action === "accept") {
				updateExecution(acceptPlanStep(execution, target.id));
				return finish(execution.status === "completed" ? "The reviewed step was accepted and the plan is complete." : "The reviewed step was accepted. The next step is ready and awaits user instruction.");
			}
			if (params.action === "correct") {
				updateExecution(requestPlanStepCorrections(execution, target.id));
				applyTools("build");
				pi.sendUserMessage(`Apply the corrections requested in the user's preceding message to plan step ${execution.steps.findIndex((step) => step.id === target.id) + 1}.`, { deliverAs: "followUp" });
				return finish("The reviewed step was reopened. The requested corrections are starting in a follow-up turn.");
			}
			if (params.action === "skip") {
				updateExecution(skipPlanStep(execution, target.id));
				return finish(execution.status === "completed" ? "The step was skipped and the plan is complete." : "The step was skipped. The next step awaits user instruction.");
			}
			if (!params.instruction?.trim()) throw new Error("Revising a step requires a replacement instruction");
			const plan = await fs.promises.readFile(planPath, "utf8");
			const updatedPlan = updatePlanChecklistStep(plan, target.sourceLine, params.instruction);
			await fs.promises.writeFile(planPath, updatedPlan, "utf8");
			updateExecution(revisePlanStep(execution, target.id, params.instruction, updatedPlan));
			return finish("The plan step instruction was revised and is awaiting user approval.");
		},
		renderCall(args, theme) {
			const requestedStep = typeof args.step === "number" && Number.isFinite(args.step) ? Math.max(1, Math.floor(args.step)) : undefined;
			const inferredStep = requestedStep ?? (execution
				? execution.steps.findIndex((step) => step.status === "ready" || step.status === "review") + 1
				: 0);
			const label = inferredStep > 0 ? `Step ${inferredStep}: ${args.action}` : `Plan: ${args.action}`;
			return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
		},
		renderResult(result, _options, theme, context) {
			const text = result.content.find((item) => item.type === "text")?.text ?? "Plan state updated";
			return new Text(theme.fg(context.isError ? "error" : "success", text), 0, 0);
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
			const step = activePlanStep(execution);
			if (!execution || !step) throw new Error("No plan step is currently active");
			updateExecution(submitPlanStepForReview(execution, step.id, params.summary));
			applyTools("build");
			return {
				content: [{ type: "text", text: "The active plan step is awaiting user review. Stop now and do not begin another step." }],
				details: { stepId: step.id, review: true },
				terminate: true,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Submit plan step for review")), 0, 0);
		},
		renderResult(_result, _options, theme, context) {
			return new Text(theme.fg(context.isError ? "error" : "success", context.isError ? "Plan step submission failed" : "Plan step ready for review"), 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_exit",
		label: "Exit Plan Mode",
		description: PLAN_EXIT_DESCRIPTION,
		parameters: EMPTY_PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("plan_exit requires an interactive TUI or RPC client");
			let plan: string;
			try {
				plan = await fs.promises.readFile(planPath, "utf8");
			} catch (error: unknown) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`Cannot request plan approval because the plan file could not be read: ${detail}`);
			}
			if (!plan.trim()) throw new Error("Cannot request plan approval because the plan file is empty");
			pi.appendEntry(PLAN_REVIEW_ENTRY_TYPE, { plan, planPath });
			const displayPath = shorten(planPath, ctx.cwd);
			let stepExecution: PlanExecutionState | undefined;
			let checklistError: string | undefined;
			const panelAvailable = fullscreenPanelCapable && (panelTui?.terminal.columns ?? 0) >= PANEL_MIN_TERMINAL_WIDTH;
			if (panelAvailable) {
				try {
					stepExecution = createPlanExecution(plan);
				} catch (error: unknown) {
					checklistError = error instanceof Error ? error.message : String(error);
				}
			}
			const choices = [
				PLAN_EXIT_APPROVE_CHOICE,
				...(stepExecution ? [PLAN_STEP_CHOICE] : []),
				PLAN_EXIT_FRESH_CHOICE,
				PLAN_EXIT_STAY_CHOICE,
			];
			const selection = normalizePlanExitChoice(await ctx.ui.select(
				`Build Agent: Plan at ${displayPath} is complete. What would you like to do?`,
				choices,
			));
			if (selection.choice === PLAN_STEP_CHOICE && stepExecution) {
				freshImplementationRequest = undefined;
				execution = stepExecution;
				await selectMode("build", ctx, "tool");
				updateExecution(stepExecution);
				ensurePanelLayout();
				return {
					content: [{ type: "text", text: "Step-by-step execution is ready. Stop now and wait for the user's natural-language instruction in the composer; the plan panel is visual-only." }],
					details: { approved: true, action: "step-by-step", mode: "build", planPath },
					terminate: true,
				};
			}
			if (panelAvailable && !stepExecution && checklistError) {
				ctx.ui.notify(`Step-by-step execution is unavailable: ${checklistError}.`, "warning");
			} else if (fullscreenPanelCapable && !panelAvailable) {
				ctx.ui.notify(`Step-by-step execution requires a terminal at least ${PANEL_MIN_TERMINAL_WIDTH} columns wide.`, "warning");
			}
			const decision = classifyPlanExitChoice(selection.choice);
			if (decision === "stay") {
				freshImplementationRequest = undefined;
				pi.appendEntry(MODE_NOTICE_ENTRY_TYPE, { message: PLAN_EXIT_STAY_ACKNOWLEDGEMENT });
				return buildPlanExitStayResult(planPath, selection.cancelled);
			}
			if (decision === "implement-fresh") {
				freshImplementationRequest = buildFreshImplementationRequest(
					plan,
					ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
					pi.getThinkingLevel(),
				);
				pi.sendUserMessage("/build-fresh", {
					deliverAs: "followUp",
					expandPromptTemplates: true,
				});
				return buildPlanExitFreshResult(planPath);
			}
			freshImplementationRequest = undefined;
			await selectMode("build", ctx, "tool");
			return {
				content: [
					{
						type: "text",
						text: `${PLAN_TO_BUILD_REMINDER}\n\nA plan file exists at ${planPath}. The plan has been approved; execute the plan now.`,
					},
				],
				details: { approved: true, mode: "build", planPath },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Request plan approval")), 0, 0);
		},
		renderResult(result, _options, theme, context) {
			const details = result.details as { approved?: boolean; action?: string } | undefined;
			if (details?.action === "step-by-step" && !context.isError) {
				return new Text(theme.fg("success", "Step-by-step execution ready — waiting for your instruction."), 0, 0);
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
			return new Text(theme.fg("warning", PLAN_EXIT_STAY_ACKNOWLEDGEMENT), 0, 0);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if ((runMode ?? selectedMode) === "build" && execution && execution.status !== "completed" && !activePlanStep(execution) && (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash")) {
			return {
				block: true,
				reason: "Step-by-step execution is waiting for an explicit natural-language instruction from the user; no step is approved for project mutations.",
			};
		}
		if (runMode !== "plan" || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const inputPath = (event.input as { path?: unknown }).path;
		if (isAllowedPlanMutation(ctx.cwd, inputPath, planPath)) return;
		return {
			block: true,
			reason: `Plan mode only permits edit/write access to the plan file: ${planPath}`,
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		runMode = selectedMode;
		applyTools(runMode);
		let content: string | undefined;
		if (runMode === "plan") {
			await ensurePlanDirectory();
			content = buildPlanReminder(describePlanFile());
		} else if (activePlanStep(execution)) {
			const step = activePlanStep(execution)!;
			content = buildPlanStepReminder(planPath, execution!.steps.findIndex((item) => item.id === step.id) + 1, execution!.steps.length, step.text);
		} else if (execution && execution.status !== "completed") {
			content = buildPlanStepWaitingReminder(execution.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.text}`).join("\n"));
		} else if (pendingReminder === "build") {
			content = PLAN_TO_BUILD_REMINDER;
			if (fs.existsSync(planPath)) content += `\n\nA plan file exists at ${planPath}. You should execute the plan defined within it.`;
		}
		pendingReminder = undefined;
		persist();
		if (!content) return;
		return { message: { customType: "pi-plan-build-reminder", content, display: false } };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		runMode = undefined;
		applyTools(selectedMode);
		updateModeIndicator(ctx);
		if (execution) ensurePanelLayout();
	});

	pi.on("session_start", async (event, ctx) => {
		currentContext = ctx;
		const entries = ctx.sessionManager.getEntries();
		const latest = entries
			.filter(
				(entry: any) =>
					entry.type === "custom" &&
					(entry.customType === STATE_TYPE || entry.customType === LEGACY_STATE_TYPE),
			)
			.pop() as { data?: unknown } | undefined;
		const decoded = decodeModeState(latest?.data);
		const raw = latest?.data as StoredState | undefined;
		execution = decodePlanExecution(raw?.execution);
		selectedMode = decoded?.selectedMode ?? (pi.getFlag("plan") === true ? "plan" : "build");
		pendingReminder = raw?.pendingReminder ?? (decoded ? undefined : pi.getFlag("plan") === true ? "plan" : undefined);
		toolsBeforeModes = Array.isArray(raw?.toolsBeforeModes)
			? raw.toolsBeforeModes.filter((name): name is string => typeof name === "string" && !MANAGED_TOOLS.has(name))
			: pi.getActiveTools().filter((name) => !MANAGED_TOOLS.has(name));
		planPath = makePlanPath(path.join(getAgentDir(), "plans"), ctx.sessionManager.getSessionId());
		if (selectedMode === "plan" || execution) await ensurePlanDirectory();
		if (execution && !fs.existsSync(planPath)) await fs.promises.writeFile(planPath, execution.planMarkdown, "utf8");
		applyTools(selectedMode);
		updateModeIndicator(ctx);

		if (ctx.mode === "tui") {
			ctx.ui.setFooter((tui, theme, footerData) => {
				const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
				return {
					dispose: unsubscribe,
					invalidate() {},
					render(width: number): string[] {
						let input = 0;
						let output = 0;
						let cacheRead = 0;
						let cacheWrite = 0;
						let cost = 0;
						let latestCacheHitRate: number | undefined;
						for (const entry of ctx.sessionManager.getEntries()) {
							const usage =
								entry.type === "message" &&
								(entry.message.role === "assistant" || entry.message.role === "toolResult")
									? entry.message.usage
									: (entry.type === "branch_summary" || entry.type === "compaction")
										? entry.usage
										: undefined;
							if (!usage) continue;
							input += usage.input;
							output += usage.output;
							cacheRead += usage.cacheRead;
							cacheWrite += usage.cacheWrite;
							cost += usage.cost.total;
							if (entry.type === "message" && entry.message.role === "assistant") {
								const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
								latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
							}
						}

						let cwd = formatFooterCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
						const branch = footerData.getGitBranch();
						if (branch) cwd += ` (${branch})`;
						const sessionName = ctx.sessionManager.getSessionName();
						if (sessionName) cwd += ` • ${sessionName}`;

						const stats: string[] = [];
						if (input) stats.push(`↑${formatTokens(input)}`);
						if (output) stats.push(`↓${formatTokens(output)}`);
						if (cacheRead) stats.push(`R${formatTokens(cacheRead)}`);
						if (cacheWrite) stats.push(`W${formatTokens(cacheWrite)}`);
						if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) {
							stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
						}
						const usingSubscription = ctx.model
							? ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model)
							: false;
						if (cost || usingSubscription) {
							stats.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
						}

						const contextUsage = ctx.getContextUsage();
						const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
						const contextPercent = contextUsage?.percent;
						const contextText = `${contextPercent === null || contextPercent === undefined ? "?" : `${contextPercent.toFixed(1)}%`}/${formatTokens(contextWindow)} (auto)`;
						stats.push(
							contextPercent !== null && contextPercent !== undefined && contextPercent > 90
								? theme.fg("error", contextText)
								: contextPercent !== null && contextPercent !== undefined && contextPercent > 70
									? theme.fg("warning", contextText)
									: contextText,
						);

						const lines = [
							truncateToWidth(theme.fg("dim", cwd), width, theme.fg("dim", "...")),
							truncateToWidth(theme.fg("dim", stats.join(" ")), width, theme.fg("dim", "...")),
						];
						const statuses = Array.from(footerData.getExtensionStatuses().entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
						if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
						return lines;
					},
				};
			});

			// Startup history is populated after session_start; replacement flows recreate the editor after that step.
			const promptHistory = event.reason === "startup" ? [] : extractPromptHistory(ctx.sessionManager.getBranch());
			class ModeEditor extends CustomEditor {
				onCycle?: () => void;
				onCycleThinking?: () => void;
				matchesThinkingCycle?: (data: string) => boolean;

				requestModeRender(): void {
					this.tui.requestRender();
				}

				override render(width: number): string[] {
					const railWidth = 2;
					const paddingWidth = Math.min(railWidth, Math.max(0, Math.floor((width - 1) / 2)));
					if (this.getPaddingX() !== railWidth) this.setPaddingX(railWidth);

					const lines = super.render(width);
					if (paddingWidth !== railWidth) return lines;

					const leftRail = `${formatModeRail(selectedMode)} `;
					const rightRail = this.borderColor("│");
					const topRightVerticalTransition = this.borderColor("┆");
					const bottomLeftVerticalTransition = formatModeRail(selectedMode, selectedMode === "build" ? "┇" : "┆");
					const metadata = truncateToWidth(
						formatModeMetadata(selectedMode, pi.getThinkingLevel(), ctx.ui.theme, this.borderColor, {
							modelName: ctx.model?.id ?? "no-model",
							modelProvider: ctx.model?.provider,
							rail: bottomLeftVerticalTransition,
						}),
						width - 1,
						"",
					);
					const topBorder = formatModeTopBorder(selectedMode, width, this.borderColor("╮"));
					return renderModeComposer(
						lines,
						topBorder,
						leftRail,
						rightRail,
						topRightVerticalTransition,
						metadata,
						formatModeRail(selectedMode, "╰"),
						railWidth,
						width,
						{
							truncate: (line, maxWidth) => truncateToWidth(line, maxWidth, ""),
							measure: visibleWidth,
						},
					);
				}

				override handleInput(data: string): void {
					if (this.matchesThinkingCycle?.(data)) {
						if (this.onExtensionShortcut?.(data)) return;
						this.onCycleThinking?.();
						return;
					}
					if (matchesKey(data, Key.tab) && !this.isShowingAutocomplete()) {
						this.onCycle?.();
						return;
					}
					super.handleInput(data);
				}
			}
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const editor = new ModeEditor(tui, theme, keybindings);
				for (const prompt of promptHistory) editor.addToHistory(prompt);
				requestEditorRender = () => editor.requestModeRender();
				panelTui = tui;
				fullscreenPanelCapable = isViewportTUI(tui) && typeof (tui as ViewportTUI).setLayoutRoot === "function";
				if (fullscreenPanelCapable && !originalLayoutRoot) {
					originalLayoutRoot = (tui as TUI & { layoutRoot?: Component }).layoutRoot;
					fullscreenPanelCapable = originalLayoutRoot !== undefined;
				}
				if (execution) ensurePanelLayout();
				editor.onCycle = () => {
					if (currentContext) void selectMode(nextMode(selectedMode), currentContext, "manual");
				};
				editor.matchesThinkingCycle = (data) =>
					keybindings.matches(data, "app.thinking.cycle") &&
					!keybindings.matches(data, "tui.editor.historyPrevious") &&
					!keybindings.matches(data, "tui.editor.historyNext");
				editor.onCycleThinking = () => {
					const level = nextThinkingLevel(pi.getThinkingLevel(), ctx.model);
					if (level) pi.setThinkingLevel(level);
					editor.requestModeRender();
				};
				return editor;
			});
			if (execution && !fullscreenPanelCapable) {
				ctx.ui.notify("Step-by-step progress was restored, but its plan panel requires fullscreen TUI mode. Progress is preserved.", "warning");
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		removePanelLayout();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
		requestEditorRender = undefined;
		panel = undefined;
		panelTui = undefined;
		panelLayoutRoot = undefined;
		originalLayoutRoot = undefined;
		fullscreenPanelCapable = false;
		currentContext = undefined;
	});
}
