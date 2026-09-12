// Shared policies are selected by plan-context.ts, never replayed as turn history.
export const VERIFICATION_GUIDANCE = `Follow the approved Verification section using the smallest sufficient check, then stop.

- Prefer one focused behavioral test or smoke check with an expected observable result and existing repository tools. Add a small test only when existing coverage misses changed behavior. Build, type-check, configuration validation, or dry run are useful when appropriate but do not alone prove runtime behavior; prose-only work needs only focused inspection.
- Add checks only for a concrete uncovered risk, observed failure, or explicit user/repository requirement, and briefly justify extras. Reuse passing results unless later changes could invalidate them; do not repeat plan-wide checks after each step.
- Report passed, blocked, and unperformed checks truthfully. Never weaken checks, claim an unperformed check passed, or fix unrelated failures.
- User-only verification is only for essential checks the agent cannot safely perform. Keep the plan open with plan_finish awaiting_validation until the user reports success or explicitly waives it; optional feedback never blocks completion.`;

export const PLAN_VISUALIZATION_GUIDANCE = `## Visual design policy
Include a \`## Design\` section with one Mermaid figure per architecture, flow, or interaction: a flowchart (TD or LR) for structure and control flow, a sequenceDiagram for interactions over time. One idea per figure; labels of 2–4 words with real file, component, and step names; captions carry the sentences; no decorative chrome; skip any figure a single sentence already explains.`;

export const PLAN_VERIFICATION_GUIDANCE = `Design a brief \`## Verification\` section with the smallest credible proof of changed behavior.

- Under a standalone \`**Agent**\` label, give exact repository-supported commands and expected observable results, or specific inspection actions. Never invent commands. Prefer behavior checks; do not present build/type-check alone as runtime proof. Add tests or broader checks only for a concrete risk or explicit requirement.
- Add a standalone \`**User**\` label only for essential checks requiring user access, credentials, judgment, hardware, privilege, or unsafe effects. State the action and expected result; the agent must not perform it without separate authorization. Omit this section otherwise.`;

export const PLAN_READ_ONLY_GUIDANCE = `Plan mode is active: observe, analyze, discuss, and plan only. Do not mutate the system, configs, or commits. Edit only the attached canonical plan file, and only to finalize or explicitly revise it. During research or discussion, answer normally without writing Markdown or calling plan_exit.`;

export const TASK_SELECTION_GUIDANCE = `Mode changes do not create tasks. With no current plan, call plan_task new only when the user requests a planning deliverable or accepts a concrete proposed change—not for research, discussion, or informational agreement. Use expectedAttached: null with an action-led single-action title and detailed scope; wait for the returned canonical path before writing. Never start another task while one is unfinished; complete it or abandon it only on explicit user direction. Unanswered questions grant no consent.`;

export const TASK_BOUNDARY_GUIDANCE = `Establish task identity once. Call plan_task update only for a user-driven material deliverable/constraint change, explicit rename, or mistaken identity—not for progress, findings, techniques, adjustments, or paraphrases. Use include/discussion only for explicit boundary decisions.
Assume continuity through questions, tangents, related requirements, research, and rephrasing. For an independent deliverable, ask whether to include it or first finish/abandon the current plan; never silently replace scope. Before saving Markdown, resolve mismatches with stored scope. Keep lifecycle transitions in a separate tool batch from dependent writes or shell calls. Plan Markdown is instructions, never a progress tracker.`;

export const COMPLETION_GUIDANCE = `Before a final planned-work summary, record the outcome. Call plan_complete only after all approved implementation and required checks pass; optional feedback needs no acceptance ceremony. Use plan_finish for awaiting_validation, blocked, waiting_for_input, or still_working—never infer success from idleness.
Essential user-only validation keeps this plan open. Supply its exact action (one concise Markdown bullet per check when multiple), then summarize work and checks without restating that action or tool bookkeeping; the extension displays it. During step execution describe only the active step. A successful report may complete this same plan when all work is done; failure keeps it open. Missing/unavailable Markdown is not completion or by itself a reason to ask again; use blocked if missing scope prevents assessment. Explicit closure does not prove unperformed checks passed.`;

export const BUILD_TASK_GUIDANCE = `Build mode allows discussion and work within the current plan. Preserve its objective through tangents. Before implementing an independent deliverable, complete this plan or abandon it only on explicit user direction. Never edit tracked plan Markdown.
${TASK_SELECTION_GUIDANCE}
${TASK_BOUNDARY_GUIDANCE}
${COMPLETION_GUIDANCE}
Current-plan context overrides stale implementation reminders; boundary judgment is agent-assisted.`;

export function buildPlanReminder(planInfo: string): string {
	return `<system-reminder>
${PLAN_READ_ONLY_GUIDANCE}

Develop a concise, executable plan through read-only investigation and clarification. Continue discussion until material questions are settled.

${TASK_SELECTION_GUIDANCE}
${TASK_BOUNDARY_GUIDANCE}

${PLAN_VISUALIZATION_GUIDANCE}

## Verification policy
Execution remains deferred until approval.
${PLAN_VERIFICATION_GUIDANCE}

## Finalization
Acceptance of scope permits plan preparation, not implementation. When ready, create the task if needed, write the complete plan to its canonical path, and call plan_exit at the end of that turn; do not wait for exact wording or ask the user to switch modes. Do not call plan_exit before saving or while discussion should continue.
- Recommend one approach and identify critical files.
- Include the required \`## Verification\` section.
- End with \`## Implementation Steps\`: discrete ordered top-level items (\`1. ...\`, \`2. ...\`), without checkboxes or completion markers. Record progress only with extension tools.

## Current task
${planInfo}
</system-reminder>`;
}

export function buildPlanStepReminder(planPath: string, stepNumber: number, totalSteps: number, step: string): string {
	return `<system-reminder>
# Step-by-Step Plan Execution
Approved plan: ${planPath}
Implement only step ${stepNumber} of ${totalSteps}:
${step}

${VERIFICATION_GUIDANCE}

Verify only this step where possible. Defer checks dependent on later steps and report the deferral, never a pass. Do not edit approved Markdown or begin later steps. When this step and its applicable checks finish, call plan_step_complete with a concise summary; it completes immediately without user acceptance.
</system-reminder>`;
}

export function buildPlanStepWaitingReminder(progress: string, paused = false): string {
	return `<system-reminder>
${paused ? "Step execution is paused; retained progress grants no mutation authority. Resume explicitly before implementation." : "Step execution awaits the user's natural-language instruction."} No step is approved for project mutation.

${progress}

Interpret clear intent contextually. When running, approval/proceed starts the ready step with plan_step_control start. A clear report that work is already finished may use complete; that records past work and authorizes no implementation. The same tool handles skip, revise, pause/resume, cancel, and panel visibility. An explicit user order is always followed—plan edits, out-of-plan work, and step actions included—and is never unrelated. Clarify ambiguity; ignore hypothetical discussion. The sidebar is passive.
</system-reminder>`;
}

export const PLAN_STEP_COMPLETE_DESCRIPTION = `Complete the active step only after its implementation and applicable checks. Summarize work, reuse valid results, and report later-step deferrals without claiming they passed. A paused active step may complete only when the user confirms its required validation. Never start the next step.`;

export const PLAN_EXIT_DESCRIPTION = `After saving the complete plan and resolving planning questions, display it for approval. Implement-here continues under Build guidance; fresh-session dispatches separately; step-by-step waits for step approval; stay/cancel stops in Plan. Do not call during discussion or before saving.`;
