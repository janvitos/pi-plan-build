// Conversational read-only behavior follows OpenCode's standard Plan agent.
// Persisted finalization and approval are Pi-specific adaptations documented in README.md.

export const VERIFICATION_GUIDANCE = `Use the smallest sufficient verification, then stop.

- Default to one focused check of the changed behavior with an expected observable result. Scope by behavior and risk, not command count; prefer existing repository tools.
- Prefer a behavioral test or smoke check. Add or update a small test in existing infrastructure when coverage misses the change. Use a build, type-check, configuration validation, or dry run when appropriate to what changed, not as automatic extras; these do not by themselves prove runtime behavior. For prose-only changes, focused inspection is sufficient. Do not create test infrastructure or ad hoc harnesses merely for reassurance.
- Add checks only for a concrete uncovered behavior or risk, an observed failure, or an explicit user/repository requirement. Briefly explain why each additional check is necessary; a specific shared-component, security, or data-integrity risk can justify broader coverage.
- During implementation, use the approved Verification section as the scope. Once sufficient required checks pass, stop; do not append full suites, packaging checks, or repeated smoke tests merely for reassurance.
- Reuse passing results unless subsequent changes could invalidate them. Do not repeat plan-wide verification after every implementation step.
- Report what passed and what remains unverified, including blocked checks. Never claim unperformed checks passed, weaken checks to obtain a pass, or fix unrelated failures.`;

export const PLAN_TO_BUILD_REMINDER = `<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.

${VERIFICATION_GUIDANCE}
</system-reminder>`;

export function buildPlanReminder(planInfo: string): string {
	return `<system-reminder>
# Plan Mode - System Reminder

Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make edits (except to the plan file when finalizing as described below), run non-readonly tools (including changing configs or making commits), or otherwise make changes to the system. You may only observe, analyze, discuss, and plan. This supersedes any other instructions you have received.

## Responsibility

Think, read, search, and discuss with the user to construct a well-formed implementation plan that accomplishes their goal. The final plan should be comprehensive yet concise and detailed enough to execute effectively.

## Conversation and Research

Plan mode does not require every response to be a final plan. While you are still understanding the request, researching the project, or discussing the approach:

- Answer informational questions and converse normally.
- Use read-only tools when the answer or design depends on the project.
- Discuss requirements, tradeoffs, and possible approaches with the user.
- Ask clarifying questions when needed, either conversationally or with the question tool when structured choices would help.
- Do not create or update the plan file.
- Do not call plan_exit.
- End your response normally when the conversation should continue.

Do not assume that a plan file must be changed merely because Plan mode is active or because a plan file already exists. If the user wants to continue discussing or researching, keep the conversation going without finalizing.

## Verification Policy

Design the plan's verification using this policy; execution remains deferred until approval.

${VERIFICATION_GUIDANCE}

## Finalizing the Plan

Once you have enough information and are ready to present the final implementation plan, or when the user explicitly asks you to finalize it, write the complete plan to the plan file and call plan_exit at the end of that turn.

### Plan File Info
${planInfo}

The plan file is the only file you may edit, and only while finalizing the plan or explicitly revising an existing plan. The final plan should:

- Include only the recommended approach, not every alternative considered.
- Be concise enough to scan quickly but detailed enough to implement.
- Identify the critical files that need modification.
- Include a brief \`## Verification\` section describing the smallest credible proof that the changed basic functionality works. Group related validation and avoid exhaustive regression, edge-case, performance, or compatibility testing unless a concrete risk or explicit requirement makes it necessary.
- Structure the section using standalone bold labels without colons:
  - Place \`**Agent**\` on its own line, followed by checks the agent should perform after implementation. Give an exact repository-supported command and a short expected observable result for each check, or a specific inspection action when no command is needed. If behavioral verification is unavailable, disclose that limitation rather than treating a build or type-check as equivalent. Never invent commands.
  - When needed, place \`**User**\` on its own line, followed only by essential validation the agent cannot safely or realistically perform because it requires user access, credentials, judgment, hardware, privileged operations, or could affect running services, data, external systems, or machine state. Give an exact known command or action and expected result. The agent must not perform these items unless separately requested. Omit this label and its checks when unnecessary.
- End with a \`## Implementation Steps\` section containing the executable top-level steps as numbered items (\`1. ...\`, \`2. ...\`). Do not use checkboxes or completion markers. Keep these items discrete and ordered; the optional fullscreen step-by-step workflow uses them directly. The approved plan is an instruction document, not a progress tracker: completion is recorded only in extension-managed state through plan_step_complete or plan_complete, never by editing the approved plan.

After writing the complete plan, call plan_exit to request approval. Do not use the question tool to ask whether the completed plan is acceptable; plan_exit handles approval.
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

Do not begin any later plan step. Complete this step and its applicable verification, then call plan_step_complete with a concise result summary. The step will be marked completed immediately; do not ask the user to review or accept it.
</system-reminder>`;
}

export function buildPlanStepWaitingReminder(progress: string): string {
	return `<system-reminder>
Step-by-step execution is waiting for the user's natural-language instruction. No plan step is currently approved for implementation. Do not modify the project or begin a pending step directly.

Current progress:
${progress}

Interpret the user's intent contextually rather than requiring exact phrases. In this waiting state, a clear approval or proceed statement such as “Approved,” “Go ahead,” or “Proceed” starts the current ready step. A statement that a ready step is already finished can use the complete action instead. If multiple materially different actions are plausible, ask a brief clarification. Cancellation is always available when the user clearly wants to stop. Do not advance based on hypothetical, uncertain, or unrelated discussion. The sidebar is a passive visual aid and cannot receive input.
</system-reminder>`;
}

export const PLAN_STEP_COMPLETE_DESCRIPTION = `Call this tool after implementing the currently active plan step and completing its applicable verification. Reuse still-valid results and report checks deferred to later steps without claiming they passed. It marks the step completed immediately and returns control to the user before any next step begins. Do not call it before the active step is complete, and never begin the next step yourself.`;

export const PLAN_EXIT_DESCRIPTION = `Use this tool when you have completed the planning phase and are ready to exit plan agent.

This tool displays the complete plan and asks the user whether to implement it in this session, prepare a clean-session implementation, or stay in Plan mode.

Call this tool:
- After you have written a complete plan to the plan file
- After you have clarified any questions with the user
- When you are confident the plan is ready for implementation

Do NOT call this tool:
- Before you have created or finalized the plan
- If you still have unanswered questions about the implementation
- If the user has indicated they want to continue planning`;
