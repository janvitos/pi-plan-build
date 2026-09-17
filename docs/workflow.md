# Workflow and plan lifecycle

[← README](../README.md)

## Overview

1. Start in **Build**, or in your configured [**Default mode**](settings.md#default-startup-mode), for ordinary discussion and coding. Small fixes need no plan.
2. Select **Plan** with `/plan`, `Alt+M`, or the default editor `Tab` shortcut. This changes permissions, **not task selection**. Plan entry is user-controlled: the agent cannot auto-route a Build request into Plan, so a planning request made in Build requires you to switch modes. Discuss and research read-only; no Markdown is written merely by entering Plan.
3. When you request a planning deliverable or accept a concrete proposed change during planning, the agent creates the current task; `/plan new` is the manual equivalent. It waits for the returned canonical path, completes necessary read-only investigation, saves the plan, and calls `plan_exit` for review and implementation approval. Accepting scope does not authorize implementation; informational agreement alone creates no task. You need not say “make a plan” again or switch manually to Build to get a plan written.
4. Approve implementation **here**, in a **clean linked session**, or **step by step** (experimental; sidebar optional). Staying in Plan—or Escape—stops the run and waits for your next message.
5. After implementation and required verification, the agent records completion. Essential user-only validation keeps the same plan attached, with a bold accent **Awaiting your validation** heading at the end of the turn and precise regular-color instructions beneath it. Optional feedback does not hold completion open.

One task retains its file, identity, decisions, and progress through mode changes and revisions. Approval and idleness never imply completion. Before starting another plan, complete the current plan or explicitly abandon it. Abandonment preserves the file but never implies success and cannot be resumed. A successful clean-session handoff is different: it transfers ownership, detaches the source record into history, and keeps only the destination copy open. **Pausing step execution** is separate: it retains the current plan and progress but permits no implementation until execution is resumed.

## Task identity, files, and boundaries

Canonical plans live at `~/.pi/agent/plans/<session-id>-001.md`, `-002.md`, etc. Existing unnumbered `<session-id>.md` files remain usable without renaming. Reserved paths are for future writing, not proof that a file exists. Context distinguishes saved, absent, and unavailable files. An unavailable file never justifies discarding its task.

`plan_task` provides `list`, `update`, `include`, `discussion`, Plan-only `new`, and explicit `abandon`. Mutations require `expectedAttached` (current sequence or `null`; legacy `sequence` remains accepted). Stale calls fail without retargeting. Abandonment requires explicit user direction and a concise reason. Deprecated `pause`/`resume` inputs are accepted only to return non-mutating upgrade guidance. Transitions must finish in a separate tool batch before dependent edits or shell calls.

The agent establishes an action-led, single-action title and the scope once. `include` records an explicit user-approved addition using the complete merged scope. `update` is reserved for an explicit rename, mistaken-identity correction, or material correction/constraint within the existing deliverable—not additions, progress, findings, techniques, or message paraphrases. `discussion` records an explicit decision to keep a topic outside the task.

Questions, research, tangents, and related changes assume continuity. For a concrete independent deliverable, the agent asks whether to include it or finish/abandon the current plan before starting another. Discussion alone needs no lifecycle change; unanswered questions grant no consent. Boundary judgment is agent-assisted, not an automatic topic detector.

After approval, task metadata is authoritative for later user-approved scope additions. Build does not rewrite the reviewed Markdown snapshot; switch back to Plan when that document itself needs revision and another review. A real stored-scope change clears any existing unfinished outcome because its validation, blocker, or progress statement no longer covers the full task. Title-only updates, discussion decisions, and no-ops preserve the outcome. Paused step execution remains paused and guarded.

Build path guards protect every tracked current or historical plan file from recognized editors when the call exposes its target. Anchor-only editors whose target remains private to another extension cannot be preflighted; see [Permission and verification limits](#permission-and-verification-limits).

## Approval and completion

Before applying an implementation choice, `plan_exit` checks that the attachment, effective mode, and plan bytes still match what was reviewed. Changes or unreadable content require fresh review; this is only a dialog-time safeguard, not ongoing drift enforcement.

`plan_complete` accepts an optional factual `summary`, retained with the completed record for `/plan history`. Empty calls and `/plan done` remain supported; missing summaries are not evidence that verification passed. History does not reopen plans or expose inert legacy detached records.

`plan_exit` renders the **complete** saved plan in the TUI transcript; in RPC, it includes the complete review in the blocking selection request's title. RPC clients control how that title is displayed. It then asks to:

- **Switch to Build and implement here**
- **Start fresh and implement**
- **Stay in Plan mode**
- **Implement step by step**, when the plan contains valid implementation steps

Each choice displays one next-action announcement. Fresh implementation announces in the destination **below the transferred plan and above the first assistant response**; other choices announce in the source. TUI announcements are durable; RPC receives notifications. Reload does not replay them.

Fresh selection stops the source run and dispatches `/build-fresh`, which creates a linked session with an immutable approved-plan/model/thinking/task snapshot. The destination session is explicitly named from the approved task title, falling back to the plan’s first top-level Markdown heading, so session lists show the work’s subject instead of the generic kickoff prompt. It uses the destination context after replacement. After destination setup stores the open plan, the source record is marked `transferred`, detached, and retained in history. Returning to the source shows a success-colored “Plan transferred to the new implementation session. You can start a new plan here.” confirmation, no plan title or active-plan context, and permits a new task. Cancellation and failures before ownership transfer leave the source plan open and retryable. A kickoff failure after transfer keeps the destination plan open and puts the request in its editor rather than falsely announcing success.

Staying or Escape says “I’ll stay in Plan mode and wait for your next instruction,” terminates the run, and waits.

The implement-here approval result explicitly instructs execution within the approved authorization boundaries; acknowledgment or initial inspection alone is not completion. Separate deployment/restart approvals still apply, and genuine blockers or interruptions may stop work. Ordinary Build discussion does not itself authorize implementation.

For normal implementation, the agent calls `plan_complete` after all approved work and required verification pass. `/plan done` is the manual equivalent. Completion does not require saved Markdown; metadata-only plans can complete too. Missing or unavailable files are not evidence that work finished and do not alone require extra confirmation. If missing scope prevents assessing completion, the agent records `blocked`. An explicit whole-plan instruction such as “Mark the plan complete” closes tracking immediately, including during running, paused, or awaiting-validation step execution, without first cancelling it or claiming unperformed work and checks passed. The completed history record retains a bounded factual snapshot of partial step progress, while the plan file remains unchanged. Build-mode, attachment, and usable-state guards still apply.

`plan_finish` records unfinished outcomes:

- `awaiting_validation`: requires an essential `userAction` and keeps the plan attached and open, with the required action shown in the main chat until resolved.
- `blocked`, `waiting_for_input`, `still_working`: record a reason and keep the plan attached.

The collapsed tool result is suppressed so the turn ends with a single human-facing notice; expanding it shows the muted acknowledgement, the required action, rationale, and plan path. The required action is also multiline tool-result content (`Awaiting your validation`, followed by the action), so it stays available to the model, RPC, and JSON clients. The human-facing notice is appended after the assistant's summary: only its short **Awaiting your validation** heading is bold accent, followed by one empty line and the action as regular-color Markdown with normal wrapping. Both use Pi's standard one-column transcript inset, and list markers use the normal conversation Markdown style. Agents use one concise bullet per concrete check when validation has multiple checks; a single check can remain a short sentence. The assistant's final response summarizes implementation and checks without restating the action or adding a closing ceremony. During step execution it describes only the active step, not the whole plan as finished. Full requirements remain in structured tool details and current context. A successful user report resolves the validation request; this same plan can complete directly only when all approved work and required verification are finished, or the user explicitly directs completion. A failed report keeps it current for remediation. Optional appearance feedback is not required validation.

For hidden outcome reconciliation and compact tool rendering, see [Internals](internals.md#outcome-reconciliation).

## Inspect plans without a model turn

Use `/plan show` to read the current plan, progress, and outstanding validation. Use `/plan history` for completed, abandoned, or transferred plans tracked on the active session branch, including recorded summaries and transfer notices. These idle commands do not approve implementation or reopen plans.

## Step-by-step execution (experimental)

![Pi step-by-step plan execution panel](images/step-by-step.png)

Step execution works in regular/narrow TUI and RPC without a sidebar. For the optional sidebar, enable fullscreen in Pi settings and restart:

```json
{ "tuiMode": "fullscreen" }
```

The passive **64-column** right panel reserves space rather than covering the transcript/editor. It wraps long step text, collapses below 132 columns, and never captures input. Plan progress and concise natural-language guidance stay fixed while only the step list scrolls. Startup asks you to say “Proceed” and points to `/plan show` for full progress and instructions. The same workflow works without a sidebar; compact tool results describe each transition and RPC receives startup guidance.

Plans end with discrete top-level instructions:

```markdown
## Implementation Steps
1. Add the parser.
2. Integrate the workflow.
3. Run focused verification.
```

Legacy unchecked `- [ ]` items remain supported; checked/nested items and fenced examples are ignored. Duplicate instructions are rejected. Revisions preserve markers/newline formatting and reject stale or reordered source content without writing different bytes.

Use ordinary prompts: “Proceed,” “Start step 2,” “I already verified this step,” “Change step 3 to …,” “Skip this step,” “Pause execution,” “Resume execution,” “Hide/show the panel,” “Cancel step execution,” or “Mark the plan complete.” The agent distinguishes an explicitly identified step completion from an explicit whole-plan completion; bare completion wording that context cannot resolve requires clarification. Hypothetical or ambiguous discussion does not advance progress.

`plan_step_control start` approves a ready step. The agent implements **only that step**, verifies applicable behavior, calls `plan_step_complete`, and waits before the next. Explicit manual completion of a ready step records already-done work; it does **not** authorize implementation. Paused active steps retain progress but cannot authorize edit/write/bash/powershell mutations or receive implementation instructions until explicitly resumed. Essential user validation pauses execution—not the plan—and keeps the active step. A successful report may complete that step without authorizing further implementation; a failed report resumes the same step for remediation.

Progress, summaries, revisions, and panel visibility survive restoration. Completing/skipping the final step marks the plan complete, removes the panel/guards, and renders a Markdown summary. An explicit whole-plan completion does the same atomically at any earlier point and records the actual completed, skipped, active, ready, and pending state instead of changing unfinished statuses. Cancelling step execution removes its guards/panel but leaves the plan unfinished and preserves any required validation request. Confirming that request does not imply that remaining plan steps are complete. In regular/reduced UI, restored progress remains controllable through prompts; no overlay fallback is used.

See [UI internals](internals.md#presentation-and-ui-compatibility) for sidebar ownership and layout integration.

## Permission and verification limits

Plan guidance allows only observation, analysis, discussion, and planning. Recognized path-bearing editor calls (`edit`, `write`, `replace`, `insert`, and `undo_last_change`) may target **only the attached canonical plan path**, and only finalization or explicitly requested revision is appropriate. Recognized pathless editor calls are blocked because their target cannot be verified. Other tools remain visible for exploration. Bash/powershell are not sandboxed in ordinary Plan mode: the read-only requirement is model guidance, not arbitrary shell classification.

Build keeps tracked Markdown read-only when a recognized editor exposes its target; completion and later user-approved scope changes belong in extension state. To revise and review the attached Markdown itself, return to Plan mode. Pathless editors remain available for ordinary approved implementation, but Pi provides no mutation metadata or target resolver with which Plan Build could inspect another extension's private anchor state. Plan Build preserves the host's live editor selection rather than force-enabling built-in tools. Guarded revisions of unimplemented steps remain supported. See [Permission boundary](internals.md#permission-boundary) for path normalization, symlink handling, and enforcement limits.

Plans include a brief `## Verification` section with standalone **Agent** and, only when essential, **User** labels. Use the smallest sufficient behavior check with repository-supported commands and expected observations; prose-only changes may use inspection. Build/type-check alone does not prove runtime behavior. Add checks only for a concrete risk, observed failure, or explicit requirement. Reuse passing results, disclose deferrals and blocked/unperformed checks, and stop after approved required checks pass. Do not downgrade essential user validation to finish. These are model instructions, not guaranteed test limits; repository/CI requirements still apply.

For persistence, context, and UI ownership details, see [Internals](internals.md). For model/thinking preferences, see [Settings](settings.md).
