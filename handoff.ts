import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildFreshImplementationHandoff, makePlanPath, type FreshImplementationRequest, type PlanTask } from "./utils.ts";
import { STATE_VERSION, STATE_TYPE, type StoredState } from "./plan-state.ts";

export interface ApprovedHandoff extends FreshImplementationRequest {
	readonly task?: PlanTask;
	readonly tools: string[];
}
export function handoffSnapshot(request: FreshImplementationRequest, task: PlanTask | undefined, tools: string[]): ApprovedHandoff {
	const snapshot = structuredClone({ ...request, ...(task ? { task } : {}), tools });
	if (snapshot.model) Object.freeze(snapshot.model);
	if (snapshot.task) {
		for (const decision of snapshot.task.decisions) Object.freeze(decision);
		Object.freeze(snapshot.task.decisions);
		Object.freeze(snapshot.task);
	}
	Object.freeze(snapshot.tools);
	return Object.freeze(snapshot);
}

/** Returns true only when the source may retry. Never uses source APIs after replacement. */
export async function startFreshHandoff(pi: ExtensionAPI, ctx: ExtensionCommandContext, request: ApprovedHandoff): Promise<boolean> {
	if (ctx.mode === "print" || ctx.mode === "json") {
		throw new Error("Fresh implementation requires TUI or RPC mode");
	}
	if (!request.model) {
		ctx.ui.notify("Cannot start implementation because no model is selected.", "warning");
		return true;
	}
	const currentModel = ctx.model;
	const implementationModel = ctx.modelRegistry.find(request.model.provider, request.model.id)
		?? (currentModel?.provider === request.model.provider && currentModel.id === request.model.id ? currentModel : undefined);
	if (!implementationModel) {
		ctx.ui.notify(`Cannot start implementation because ${request.model.provider}/${request.model.id} is unavailable.`, "warning");
		return true;
	}
	try {
		const modelSelected = await pi.setModel(implementationModel);
		if (modelSelected === false) {
			ctx.ui.notify(`Cannot start implementation because no API key is available for ${request.model.provider}/${request.model.id}.`, "warning");
			return true;
		}
		pi.setThinkingLevel(request.thinkingLevel);
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Cannot start implementation with ${request.model.provider}/${request.model.id}: ${detail}`, "warning");
		return true;
	}

	const parentSession = ctx.sessionManager.getSessionFile();
	const sourceTools = [...request.tools];
	const sourceTask = request.task;
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
						1,
					);
					await fs.promises.mkdir(path.dirname(destinationPlanPath), { recursive: true });
					await fs.promises.writeFile(destinationPlanPath, request.plan, { encoding: "utf8", flag: "wx" });
					sessionManager.appendModelChange(request.model.provider, request.model.id);
					sessionManager.appendThinkingLevelChange(request.thinkingLevel);
					sessionManager.appendCustomEntry(STATE_TYPE, {
						version: STATE_VERSION,
						selectedMode: "build",
						pendingFreshAnnouncement: true,
						toolsBeforeModes: sourceTools,
						collection: { records: [{ plan: { sequence: 1, status: "open", ...(sourceTask ? { task: sourceTask } : {}) } }], attached: 1, counter: 1 },
						planSessionId: sessionManager.getSessionId(),
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
						`Fresh implementation session started with plan ${destinationPlanPath}.`,
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
			ctx.ui.notify("Fresh implementation cancelled; the source plan remains available.", "info");
			return true;
		}
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		try {
			ctx.ui.notify(`Unable to start a fresh implementation session: ${detail}`, "error");
		} catch {
			// The source command context may be stale after partial session replacement.
		}
		return true;
	}
	return false;
}
