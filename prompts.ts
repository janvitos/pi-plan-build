// Shared policies are selected by plan-context.ts, never replayed as turn history.
export const VERIFICATION_GUIDANCE = `Use the smallest sufficient verification, then stop.

- Default to one focused check of the changed behavior with an expected observable result. Scope by behavior and risk, not command count; prefer existing repository tools.
- Prefer a behavioral test or smoke check. Add or update a small test in existing infrastructure when coverage misses the change. Use a build, type-check, configuration validation, or dry run when appropriate to what changed, not as automatic extras; these do not by themselves prove runtime behavior. For prose-only changes, focused inspection is sufficient. Do not create test infrastructure or ad hoc harnesses merely for reassurance.
- Add checks only for a concrete uncovered behavior or risk, an observed failure, or an explicit user/repository requirement. Briefly explain why each additional check is necessary; a specific shared-component, security, or data-integrity risk can justify broader coverage.
- During implementation, use the approved Verification section as the scope. Once sufficient required checks pass, stop; do not append full suites, packaging checks, or repeated smoke tests merely for reassurance.
- Reuse passing results unless subsequent changes could invalidate them. Do not repeat plan-wide verification after every implementation step.
- Optional feedback is not required verification and must not prevent completion. Reserve user-only verification for essential checks; if these remain outstanding after implementation, record awaiting_validation, explain the required action in the main chat, and keep the plan attached and open until the user reports success or explicitly directs completion. Never downgrade an approved essential check to optional merely to finish.
- Report what passed and what remains unverified, including blocked checks. Never claim unperformed checks passed, weaken checks to obtain a pass, or fix unrelated failures.`;

export const PLAN_READ_ONLY_GUIDANCE = `Plan mode is active. Observe, analyze, discuss, and plan only. Do not run non-readonly tools, change configs, commit, or otherwise modify the system. Only the attached canonical plan file may be edited, when finalizing or explicitly revising it. During discussion/research, answer normally without writing Markdown or calling plan_exit.`;

export const TASK_SELECTION_GUIDANCE = `Mode changes do not create tasks. There can be only one current unfinished plan. When no current plan exists, use plan_task new for an explicitly requested planning deliverable or a concrete proposed change the user accepts in a planning conversation. Entering Plan, research, informational agreement, or discussion alone does not create a task. Supply expectedAttached: null, an action-led title, and scope; await the returned canonical path before writing. If one exists, complete it or use abandon only on explicit user direction before starting another. Supply expectedAttached, await the transition result, then use the canonical path. Unanswered questions grant no consent.`;

export const TASK_BOUNDARY_GUIDANCE = `Establish a single-action, action-led title and the deliverable/scope once during planning. Use plan_task update subsequently only for a user-driven material change to the deliverable or defining constraints, an explicit rename, or correction of mistaken identity—not progress, findings, proposed/rejected techniques, implementation adjustments, or paraphrases. Keep these in conversation and the eventual plan; do not repeat unchanged metadata calls.
Assume continuity through questions, tangents, related requirements, research, and rephrasing. Never silently replace scope. For a concrete independent deliverable, ask whether to include it or finish/abandon the current plan before starting another; discussion alone needs no lifecycle change. Use include/discussion only to record explicit task-boundary decisions. Before saving Markdown, compare its deliverable to stored scope and resolve outstanding mismatches; do not repeat settled questions. Explicit user direction can authorize abandonment, but never infer it. Task transitions and dependent file writes or shell commands must use separate tool batches. Saved plan Markdown is an instruction document, never a progress tracker.`;

export const COMPLETION_GUIDANCE = `Before announcing finished planned implementation, call plan_complete when implementation and all required checks passed; do not wait for ceremonial acceptance or optional feedback. If essential user-only validation remains, call plan_finish awaiting_validation with the exact userAction. The plan stays current, attached, and open. In the final response, summarize implementation and checks without overstating verification; the extension presents the validation request at the end of the turn, so do not restate the required action or add a closing ceremony. Do not repeat tool bookkeeping. During step execution describe only the active step, not the entire plan as finished. Validation notices do not belong in the composer title or border. When the user reports success or explicitly directs completion/waives validation, complete this same plan directly—no list/resume ceremony. A failed report keeps it current for remediation. Otherwise record blocked, waiting_for_input, or still_working with a reason. Never waive checks, imply unperformed checks passed, or infer success from idleness. Completion does not require saved Markdown: metadata-only plans can complete too. A missing or unavailable plan file is not evidence that work finished and does not alone require extra confirmation. If missing scope prevents assessing completion, use plan_finish blocked. Explicit user-directed closure closes tracking; it does not establish that unperformed checks passed.`;

export const BUILD_TASK_GUIDANCE = `Build mode permits free discussion and work within the current plan. Keep its objective through ordinary conversation. Informational tangents need no lifecycle change. Before implementing a separate deliverable, complete the current plan or explicitly abandon it; never hide unfinished work by replacing it. Saved plan Markdown remains read-only in Build.
${TASK_SELECTION_GUIDANCE}
${TASK_BOUNDARY_GUIDANCE}
${COMPLETION_GUIDANCE}
Current-plan context overrides stale implementation reminders; boundary judgment is agent-assisted, not an automatic topic detector.`;

export function buildPlanReminder(planInfo: string): string {
	return `<system-reminder>
${PLAN_READ_ONLY_GUIDANCE}

Think, read, search, and discuss requirements and tradeoffs to construct a comprehensive yet concise implementation plan. Ask clarifying questions when needed, conversationally or with question. Plan mode does not require every response to be a final plan; continue discussion normally until ready.

${TASK_SELECTION_GUIDANCE}
${TASK_BOUNDARY_GUIDANCE}

## Verification policy
Design verification now; execution remains deferred until approval.
${VERIFICATION_GUIDANCE}

## Finalization
Acceptance of a concrete proposed change approves its scope for plan preparation, not implementation. Once requirements are sufficiently settled, finish necessary read-only investigation, create the task if needed, write the complete plan at its returned canonical path, and call plan_exit at the end of that turn. Do not wait for the exact words “make a plan” or ask the user to switch manually to Build instead of preparing the plan. Clarify material unanswered questions first. When explicitly asked to finalize, follow this same workflow. Do not ask for approval through question; plan_exit handles it. Leave existing Markdown unchanged during discussion/research.
- Recommend one approach, concise enough to scan and detailed enough to execute; identify critical files.
- Include a brief \`## Verification\` section with the smallest credible proof of changed basic functionality. Avoid exhaustive regression, edge-case, performance, or compatibility testing unless concrete risk or an explicit requirement justifies it.
- Use standalone bold labels without colons. Under \`**Agent**\`, give exact repository-supported commands with expected observable results, or specific inspection actions. Never invent commands; disclose missing behavioral verification rather than treating build/type-check as equivalent.
- Include \`**User**\` only for essential checks requiring user access, credentials, judgment, hardware, privileged operations, or unsafe effects on services/data/external systems/machine state. Give known actions and expected results; the agent must not perform these unless separately requested. Omit when unnecessary.
- End with \`## Implementation Steps\`: discrete ordered top-level numbered items (\`1. ...\`, \`2. ...\`), no checkboxes or completion markers. Record completion only through extension-managed step/plan tools, never by modifying the approved instructions.

## Current task
${planInfo}
</system-reminder>`;
}

export const PLAN_ENTER_DESCRIPTION = `Use this tool when the user asks you to plan, when a request needs investigation before implementation, or when switching to the plan agent is the safest next step. The tool changes the current continuation to Plan mode.`;

export function buildPlanStepReminder(planPath: string, stepNumber: number, totalSteps: number, step: string): string {
	return `<system-reminder>
# Step-by-Step Plan Execution
The approved plan is at ${planPath}. Implement only step ${stepNumber} of ${totalSteps}:
${step}

${VERIFICATION_GUIDANCE}

Validate only the active step as needed. Defer checks that depend on later steps to the plan's verification step and explicitly report those deferrals, not a passing result.
Do not begin any later plan step or edit approved Markdown. Complete this step and its applicable verification, then call plan_step_complete with a concise result summary. It marks the step completed immediately; do not ask the user to review or accept it.
</system-reminder>`;
}

export function buildPlanStepWaitingReminder(progress: string, paused = false): string {
	return `<system-reminder>
${paused ? "Step-by-step execution is paused. An active step retains progress but is NOT executable. Explicitly resume execution before implementing; recording already-done work is not implementation approval." : "Step-by-step execution is waiting for the user's natural-language instruction."} No plan step is currently approved for implementation. Do not modify the project or begin a pending step directly.

Current progress:
${progress}

Interpret intent contextually rather than requiring exact phrases. When running (not paused), clear approval or proceed statements such as “Approved,” “Go ahead,” or “Proceed” start the ready step using plan_step_control start. A clear statement that a ready step is already finished may use complete instead; this records past work, not permission to implement. Clarify when materially different actions are plausible. Cancellation remains available. Do not advance based on hypothetical, uncertain, or unrelated discussion. The sidebar is passive and cannot receive input.
</system-reminder>`;
}

export const PLAN_STEP_COMPLETE_DESCRIPTION = `Call this tool after implementing the currently executable plan step and completing its applicable verification. Reuse still-valid results and report checks deferred to later steps without claiming they passed. It marks the step completed immediately and returns control to the user before any next step begins. Do not call before the step is complete or during an ordinary execution pause. The only paused exception is when the user explicitly reports that the active step's required awaiting_validation action succeeded; that confirmation may complete the step but authorizes no new implementation. Never begin the next step yourself.`;

export const PLAN_EXIT_DESCRIPTION = `Display the complete saved plan and request user approval after finalizing it and resolving planning questions. Do not call before saving or while the user wants to continue discussion/research.
After approval to implement here, execute the approved attached plan under current Build guidance. Staying in Plan stops and waits for the next user message. Fresh-session selection dispatches implementation separately and stops the source run. Step-by-step selection waits for explicit step instructions, not whole-plan execution. Respect terminating results; approval never marks the plan complete.`;
