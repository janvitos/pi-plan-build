// Prompt text pinned to OpenCode 1.18.16. The subagent phases are intentionally
// adapted to direct Pi exploration/design, as documented in README.md.

export const PLAN_TO_BUILD_REMINDER = `<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.
</system-reminder>`;

export function buildPlanReminder(planInfo: string): string {
	return `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${planInfo}
Only when the current request requires an implementation plan should you build the plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Informational Questions

If the user asks an informational question and does not ask you to make changes or produce an implementation plan, answer the question directly instead of starting the workflow below.

- You may use read-only tools to inspect the project when the answer depends on it.
- Do not create or update the plan file.
- Do not call the question tool merely because the request is phrased as a question; use it only when clarification is actually needed.
- Do not call plan_exit.
- End your response normally after answering. Plan mode remains active for future requests.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Focus on understanding the user's request and the code associated with their request.
2. Explore the codebase directly with Pi's read, grep, find, ls, and read-only shell operations. Read the minimum set of high-value files needed to understand existing patterns and testing.
3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Design the implementation directly based on the user's intent and your exploration results. Consider simplicity, correctness, maintainability, existing patterns, edge cases, and verification. Skip extended design only for truly trivial tasks such as typo fixes, single-line changes, or simple renames.

### Phase 3: Review
Goal: Review the design and ensure alignment with the user's intentions.
1. Read the critical files identified during exploration to deepen your understanding.
2. Ensure that the design aligns with the user's original request.
3. Use question tool to clarify any remaining questions with the user.

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives.
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively.
- Include the paths of critical files to be modified.
- Include a verification section describing how to test the changes end-to-end (run the code, use available tools, run tests).

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`;
}

export const PLAN_ENTER_DESCRIPTION = `Use this tool when the user asks you to plan, when a request needs investigation before implementation, or when switching to the plan agent is the safest next step. The tool changes the current continuation to Plan mode.`;

export const PLAN_EXIT_DESCRIPTION = `Use this tool when you have completed the planning phase and are ready to exit plan agent.

This tool displays the complete plan and asks the user whether to implement it in this session, prepare a clean-session implementation, or stay in Plan mode.

Call this tool:
- After you have written a complete plan to the plan file
- After you have clarified any questions with the user
- When you are confident the plan is ready for implementation

Do NOT call this tool:
- Before you have created or finalized the plan
- If you still have unanswered questions about the implementation
- If the user has indicated they want to continue planning
- After directly answering an informational question that did not require an implementation plan`;
