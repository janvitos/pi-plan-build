# Pi Plan & Build

**Plan safely, approve explicitly, then implement here or in a clean session.**

A global [Pi coding agent](https://github.com/badlogic/pi-mono) extension that adds persistent **Plan** and **Build** modes, guarded plan-file editing, interactive planning questions, full-plan review, explicit approval, and clean-session implementation handoffs.

## Plan mode

Explore a codebase, ask questions, and prepare an implementation plan without modifying project files.

![Pi Plan mode composer](docs/images/plan.png)

## Build mode

Switch to Build mode to implement the approved plan directly in the current session or a clean session.

![Pi Build mode composer](docs/images/build.png)

## Step-by-step execution

Optionally keep the approved plan visible in a docked side panel while implementing and verifying one step at a time.

![Pi step-by-step plan execution panel](docs/images/step-by-step.png)

## Features

- New sessions start in **Build** mode.
- By default, `Alt+M` cycles **Build → Plan → Build** in every TUI setup, and `Tab` also cycles modes in Pi Plan Build's custom composer while autocomplete is closed. An open autocomplete menu keeps normal Tab selection. Use `/plan-settings` to restore Tab-triggered file completion or configure your own shortcuts.
- The custom composer uses OpenCode prompt-inspired blue/orange mode colors on the rounded top-left border and left rail, complemented by Pi's border color on the right rail and rounded bottom-right border; rounded corners inherit their vertical rail colors while horizontal `╌` segments bridge the borders at both junctions, paired with a light vertical `┆` at the top right and a mode-specific bottom-left transition: thin `┆` in Plan and heavy `┇` in Build. The active composer and submitted user messages use a continuous solid thin `│` left rail in both modes. These rails use the active Pi theme's `warning` color in Plan and `thinkingLow` color in Build, and submitted messages retain their original mode after mode changes and session restores. Its metadata row shows mode, model, provider, and thinking level; cycling the thinking level updates that row directly.
- Pi Plan Build leaves the footer untouched; Pi or another installed extension remains responsible for path, usage, model, provider, thinking, and extension-status information.
- `/plan`, `/build`, and the `--plan` startup flag.
- Per-task plans at `~/.pi/agent/plans/<session-id>-001.md`, `-002.md`, etc., with the active plan and completion status persisted in the session. Existing `<session-id>.md` plans remain usable.
- In Plan mode, built-in `edit` and `write` are restricted to the exact plan file.
- Interactive `question`, `plan_enter`, and `plan_exit` tools.
- Plan mode supports read-only conversation and research across multiple turns, then persists the final plan when it is ready for approval.
- The complete saved plan is rendered in the transcript before approval—without the built-in write preview's truncation.
- Existing approval actions remain available:
  - **Switch to Build and implement here**
  - **Start fresh and implement**
  - **Stay in Plan mode**
- **Experimental:** In fullscreen TUI, plans with valid implementation steps also offer **Implement step by step** when Pi Plan Build owns the optional fullscreen layout: a passive, non-overlapping docked right panel keeps the plan visible while natural-language prompts gate steps and report completed work. The panel is visual-only and never captures keyboard input. This feature is still under active development.
- Compatible editor decorators can wrap Pi Plan Build's editor without disabling its composer. If another extension replaces rather than invokes that editor, already owns the editor before Plan Build starts, or replaces the fullscreen layout, Plan Build automatically uses reduced UI: it keeps the core Plan/Build workflow and mode status but does not replace that editor or offer a new step-by-step panel.
- Staying in Plan mode—or pressing Escape in the approval dialog—produces a durable acknowledgement and stops the run until the user responds.
- Plan mode state survives compactions, reloads, resumes, and forks.
- When Pi Plan Build's custom editor is active and Pi recreates it, the latest 100 user prompts from the active session branch are restored for Up/Down history navigation.

## Requirements

- Pi `0.84.2` or newer
- Node.js `22.6` or newer for the test command
- TUI or RPC UI support for interactive questions and approval dialogs
- Pi fullscreen TUI mode for the optional docked step-by-step plan panel; regular mode and all existing workflows remain supported

## Install

Install the npm package with Pi's package manager:

```bash
pi install npm:@janvitos/pi-plan-build
```

Pi stores npm packages under `~/.pi/agent/npm/`; `~/.pi/agent/extensions/` is reserved for directly auto-discovered extension files and directories. Start a new Pi process after installation, or run `/reload` in an existing session.

### Install from GitHub

```bash
pi install git:github.com/janvitos/pi-plan-build
```

### Local development install

```bash
git clone https://github.com/janvitos/pi-plan-build.git ~/src/pi-plan-build
ln -s ~/src/pi-plan-build ~/.pi/agent/extensions/pi-plan-build
```

Do not install more than one npm, Git, or local copy at the same time; duplicate extension loads cause command and flag conflicts.

## Usage

| Action | Result |
| --- | --- |
| `Alt+M` | Default shortcut to cycle Build and Plan in any TUI setup |
| `Tab` (default editor shortcut) | With the custom composer active, cycle modes when autocomplete is closed; accept a suggestion when it is open |
| `/plan-settings` | Choose a shortcut preset or locate the custom configuration file |
| `/plan` | Resume the unfinished plan, or select a new plan file after completion |
| `/plan new` | Start a separate task in Plan mode, preserving the previous unfinished plan and its progress as paused |
| `/plan pause` | Detach the current plan so unrelated work does not advance it |
| `/plan resume [sequence]` | Reattach a paused plan; choose from a list when more than one is available |
| `/plan list` | List tracked plans, identities, attachment state, and paths |
| `/plan done` | In Build mode, explicitly mark the saved plan's implementation complete |
| `/build` | Select Build mode |
| `pi --plan` | Start a new session in Plan mode |
| `/build-fresh` | Start a pending clean-session implementation manually |

### Shortcut configuration

Run `/plan-settings` to see the active shortcuts and choose:

- **Tab + Alt+M** (default): keep the existing mode-switching workflow.
- **Alt+M only**: leave Tab entirely to Pi autocomplete.
- **Disabled**: use `/plan` and `/build` without mode shortcuts.
- **Custom (edit config file)**: show the file path and an example without changing your configuration.

Presets update the same configuration file used for custom shortcuts and preserve unrelated settings. Cancel makes no changes. Run `/reload` after saving a preset or manually editing the file; the active shortcuts stay unchanged until reload. The selector refuses to overwrite malformed JSON.

**Tab tradeoff:** Pi normally uses Tab to request file completion even with no menu open (for example, `Review READ` + Tab can suggest `README.md`). The default editor shortcut intentionally replaces that action with mode switching. It does not interfere with accepting a suggestion from an already-open menu. Choose **Alt+M only** if you use Tab to request completion.

Pi Plan Build reads its user configuration from `~/.pi/agent/pi-plan-build.json` (or `$PI_CODING_AGENT_DIR/pi-plan-build.json`). The default behavior is equivalent to:

```json
{
  "shortcuts": {
    "toggleMode": ["alt+m"],
    "toggleModeInEditor": ["tab"]
  }
}
```

`toggleMode` registers global shortcuts through Pi and follows Pi's built-in conflict rules: reserved shortcuts may be skipped with a warning. `toggleModeInEditor` works only while Pi Plan Build's custom composer is active and yields while autocomplete is open. Each action accepts one Pi key string or an array of keys. Use an empty array to disable that action; disable both to remove every Plan Build mode shortcut. Omitted actions retain their defaults. For Alt+M only, set `toggleModeInEditor` to `[]`.

```json
{
  "shortcuts": {
    "toggleMode": "ctrl+alt+m",
    "toggleModeInEditor": ["ctrl+shift+m"]
  }
}
```

Use lowercase Pi `modifier+key` syntax, such as `ctrl+alt+m`, `ctrl+shift+m`, or `f6` (navigation names include `pageUp` and `pageDown`). Put bare `"tab"` only in `toggleModeInEditor`; a global Tab binding is rejected because it would intercept open-menu completion too. Avoid assigning the same key to both actions if you want editor-only autocomplete protection: global shortcuts still run while a menu is open.

Known unsupported matcher forms, including `+`/`ctrl++`, modified Escape, and modified function keys, are rejected. Advanced modifier combinations depend on terminal support; legacy terminals may report different key combinations identically. Invalid JSON or key strings show a warning and use the defaults above for affected actions, including Tab for an invalid editor action.

The agent may also enter Plan mode with `plan_enter` when planning or investigation is safer than immediate execution.

### Plan lifecycle

One task uses one plan file across discussion, revisions, approval, and temporary mode changes. Approval or the end of an agent turn does **not** mark implementation complete. For normal Build execution, the agent calls `plan_complete` after finishing implementation and required verification; `/plan done` is the manual equivalent. Completing the final step in step-by-step execution also marks the plan complete. The next entry into Plan mode selects a new numbered file without modifying the old one.

### Active task and topic changes

The composer’s top border shows only the unfinished task’s title (for example, `Fix login redirects`) in both Plan and Build modes. It stays visible through pauses and mode switches, disappears on completion, and changes when a separate task starts. Long titles truncate to fit. Mode/model/provider/thinking metadata is embedded directly in the bottom border, matching the top title's placement, with its existing colors and width-aware truncation. The same task label appears in the existing status indicator when another extension owns the composer; plan numbers remain internal.

For older saved plans without task metadata, the first nonempty top-level Markdown heading outside fenced code is used as a display fallback, without changing the file or inferring scope. Task metadata takes precedence. If neither supplies a title, `Untitled task` appears only for an existing unfinished task/plan with metadata or a saved file. Empty reserved plan slots show no task label in either mode, including when returning to Plan mode after completion. Fresh-session implementation preserves task metadata and its title.

The agent uses `plan_task` to persist a stable title, scope, and user boundary decisions without creating or editing plan Markdown during discussion. It assumes continuity for clarifications, research, and tangents. When a request introduces a concrete independent deliverable, it can ask whether to start a separate plan, include the work in this plan, or keep it discussion-only. Decisions survive resume and are supplied to the agent after compaction; rephrasing a settled topic should not prompt again. A later request to turn discussion into planned work may warrant reconsideration.

An explicit request for a separate plan already authorizes the agent to start one without another confirmation. Before saving, the agent checks the intended deliverable against the active scope and resolves outstanding mismatches. This is agent-assisted judgment, not a guaranteed topic detector. The extension enforces task sequence/path transitions, blocks file writes in the same batch as task metadata changes, and preserves earlier plan files.

To try the behavior in a disposable session: enter `/plan`, ask for a login-fix plan, clarify a related requirement, and discuss another CLI. The title should remain stable without boundary questions. Request billing exports as independent work: expect one boundary question. Choose discussion-only and rephrase that discussion: expect no repeat. Explicitly request a separate billing-export plan: expect the title to change without another confirmation, while the login plan remains preserved. Narrow the terminal to check title truncation.

Use `/plan new` for an unrelated planning task before the current plan is finished. It preserves the previous plan's file, metadata, decisions, and step progress as a paused record, and clears its pending fresh-session handoff. Lifecycle commands require an idle agent. Cancelling step execution does not mark a plan complete.

### Finishing planned implementation

The agent owns completion: after implementation and all required checks pass, it calls `plan_complete` before announcing completion. Optional feedback such as trying the appearance after a reload is not an acceptance gate. Required user-only validation must not be silently waived.

When work is unfinished, Build exposes `plan_finish`. `awaiting_validation` requires a concrete essential user action and pauses/detaches the plan while preserving its progress. `blocked`, `waiting_for_input`, and `still_working` record a reason and leave it attached and unfinished. The outcome appears in context and plan listings. Successful resumed normal implementation supersedes the earlier outcome. A later validation confirmation should explicitly identify and resume the paused plan before completion.

For normal saved-plan Build implementation, the extension can issue one hidden bookkeeping reminder if the agent ends normally without recording an outcome. Eligibility comes from approved normal implementation or a successful project edit/write—not idle state, final-answer wording, or arbitrary shell commands. The reminder never authorizes extra implementation/tests or implies success. Interruptions, errors, pending input, detached work, Plan mode, and step execution do not trigger it. Attempts are consumed before dispatch and are not replayed on reload. If ignored, the plan stays unfinished; no repeat loop or forced completion occurs. Shell-only work outside the approved flow may not trigger the safeguard, so explicit agent finishing remains the primary contract.

### Tool status and agent guidance

Planning and question tool results describe user-relevant outcomes: mode changes, completion, step progress, answers, errors, and essential user actions. Raw results are concise too, so RPC clients and renderer fallbacks do not receive full mode reminders or agent coaching. Default and expanded renderers preserve actual failures; partial results do not claim success or cancellation. Agent-only continuation, approval, and completion instructions remain in tool guidance and hidden model context, with termination and handoff behavior unchanged. Hidden (`display: false`) means hidden in the normal UI, not inaccessible through session/API data.

### Reserved paths and compact task results

A reserved plan path does not mean a Markdown file exists. Agent context explicitly distinguishes saved files, absent files reserved for future writing, and unavailable files. Detached Build work needs no plan lookup or metadata initialization. When restoring Build sessions, empty legacy or previously migrated open slots with no metadata, progress, or existing file are detached and omitted from resumable inventories; numbering is retained. Genuine unsaved tasks with title/scope metadata or execution state are preserved, as are records whose files cannot be checked safely.

`plan_task` returns concise action results instead of full instruction blocks. Expand a result to inspect attachment/path/file-state details; `list` and `/plan list` show a readable inventory. Current planning restrictions and attachment context are supplied privately to the model before its next response. Identical metadata updates do not save redundant state, and agent guidance discourages repeated bookkeeping calls.

### Unrelated Build work and paused plans

Build allows free discussion and independent coding. Questions, tangents, research, and related changes normally keep the same attachment. A clear request such as “pause this and fix X” authorizes the agent to detach the plan and handle X without asking again. For an independent coding request whose relationship is ambiguous, the agent asks once whether to include it in the current task or pause the plan and work separately. It remembers your decision. Small detached fixes require no new plan.

`plan_task` supports `list`, `pause`, and `resume` in both modes, as well as metadata-only `update`, `include`, and `discussion` for an attached plan. `new` remains Plan-only. Mutating actions validate the expected attachment; resume uses an explicit target sequence after resolving the user's intended title. Commands provide manual equivalents; `/plan resume` selects the sole paused plan or asks which one, and noninteractive clients must supply a sequence when ambiguous.

Multiple paused plans can coexist, but only one is attached. Detaching hides its title/panel and removes its step tools and implementation reminders without losing progress. Resuming preserves any other attached unfinished plan as paused; it does not change mode, execute code, or grant new step approval. The step-runner's existing pause toggle is separate: it pauses execution inside the attached plan rather than detaching it. Completion applies only to the attachment. Entering Plan mode while detached reserves a new plan, never silently resumes a paused one.

Tracked plan Markdown remains read-only in Build even when paused. Plan mode can edit only its attached canonical plan file. Transitions must precede dependent edits/shell calls in a separate tool batch. These guards protect lifecycle identity and tracked edit/write paths; semantic topic recognition is agent-assisted, and this is not a shell/filesystem sandbox.

Plan collections survive reload and branch restoration. Forks copy tracked saved files into the child session's canonical paths, leaving source files intact. Fresh implementation transfers only the selected approved plan; other paused plans remain in the source session.

Plan files are written only when finalizing or revising, not merely when selecting a new task. Reload/resume restores the active file and lifecycle; forks copy the tracked plan into the child session's own file. Legacy unnumbered files are retained without renaming.

### Plan approval

When planning is complete, `plan_exit` displays the entire persisted plan and asks whether to:

1. implement in the current session;
2. start a clean linked implementation session;
3. stay in Plan mode; or
4. **experimentally implement step by step** in fullscreen TUI when the plan contains a valid implementation-step list and no other extension owns the optional editor/layout UI.

Every approval-menu choice displays a one-line next-action announcement before proceeding. **Start fresh and implement** displays its one-time announcement in the **new session, below the full transferred plan and above the first assistant response or tool activity**; other choices announce in the current session. Reloading or resuming the destination does not append another announcement. TUI announcements remain in the transcript, while RPC clients receive a notification.

Selecting **Start fresh and implement** stops the current run and automatically dispatches `/build-fresh`. Pi 0.84.2 or newer is required for extension command dispatch from an injected user message. The command creates a linked child session, copies the approved plan to its canonical plan file, preserves the model and thinking level selected for the action, switches it to Build, and starts implementation without transferring the planning conversation.

Selecting **Stay in Plan mode**, or pressing Escape while the approval dialog is open, displays:

> I’ll stay in Plan mode and wait for your next instruction.

Both actions leave Plan mode active, stop the agent, and wait for the next user message.

New plans use numbered instructions, not completion checkboxes:

```markdown
## Implementation Steps
1. Add the parser.
2. Integrate the workflow.
3. Run focused verification.
```

Completion is tracked in extension-managed state and the UI through `plan_step_complete` or `plan_complete`, not by editing the approved plan. Existing unchecked `- [ ]` items remain supported for compatibility; existing plan files are not automatically rewritten.

### Step-by-step execution details (Experimental)

> **Experimental feature:** Step-by-step execution is still being developed. Expect UI and workflow changes, and please report issues or unexpected behavior.

When Pi uses `"tuiMode": "fullscreen"`, Pi Plan Build still owns its custom editor/layout UI, and the saved plan contains top-level numbered items under `## Implementation Steps`, `plan_exit` offers the additional **Implement step by step** approval action. This is opt-in per plan; it does not replace either one-shot implementation option or **Stay in Plan mode**.

The passive 64-column right panel reserves terminal columns, so the transcript and editor reflow instead of being covered. Long step instructions wrap instead of being clipped. It never accepts focus or keyboard input and collapses below 132 terminal columns. The panel is a visual status aid only; all control happens through ordinary prompts. The last cell always shows wrapped **How to use** instructions: write instructions in the chat, write “Proceed” to start the next step, or ask to edit, skip, mark complete, pause, resume, cancel, hide, or show the plan. You can use your own words. These instructions stay unchanged across execution states rather than repeating selected-step details or results; completion summaries remain in the main conversation. When step-by-step mode starts, a one-time message in the main transcript says: “Write ‘Proceed’ to start the first step. Instructions are shown at the bottom of the plan panel.” The agent interprets intent contextually, so these are examples rather than required commands:

- “Implement the next step,” “Start step 2,” or simply “Approved” / “Go ahead.”
- “Step 1 is complete,” “I verified that one,” or “I already handled this.”
- “Change step 3 to …” or “Skip this step.”
- “Pause the plan,” “hide the plan,” or “show the plan.”
- “Cancel this plan” at any point to end step-by-step execution immediately.

The extension exposes these actions to the agent through `plan_step_control`; project mutations remain blocked until the user clearly approves a ready step or explicitly indicates that it is already complete. A ready step may be marked complete without implementation when the user says they already handled or verified it. An implemented step is marked completed immediately after verification, and the next step becomes ready without a review or acceptance phase. The agent interprets intent contextually rather than requiring exact phrases, while the extension validates every resulting state transition. Step tool results identify the affected step, for example `Step 2: complete`, rather than presenting a plan-wide completion label. When the final step is completed or skipped, the panel and execution guards are removed immediately and the main window receives a Markdown-formatted completion summary with plan-style headings, spacing, and colors. Cancelling removes the panel and execution guards immediately, restores the full-width layout, and preserves the saved plan file for reference. The agent implements only that step, calls `plan_step_complete`, and waits for the user's next prompt. Progress, revisions, summaries, and panel visibility survive reload/resume. If such a session is opened in regular mode, progress is retained but cannot advance until fullscreen mode is restored; no overlay fallback is used.

Enable fullscreen in `~/.pi/agent/settings.json` and restart Pi:

```json
{
  "tuiMode": "fullscreen"
}
```

The integration uses Pi 0.84.2's public fullscreen layout primitives plus a guarded read of its runtime layout root because the current extension API exposes `setLayoutRoot()` but not a corresponding getter. Before installing or removing the panel, Pi Plan Build verifies that it still owns the relevant layout slot. For editor composition, it recognizes a later factory as compatible when that factory invokes Plan Build's editor factory; decorators such as global-history wrappers therefore retain the full composer. A non-composing editor replacement or conflicting layout shows one warning, reports the current mode through Pi's keyed extension status, and disables only the custom composer and new step-by-step panel. Existing restored step progress is retained for prompt-based completion or cancellation.

## Plan-file permissions

Normal tools remain visible so the model can inspect the project. While a Plan run is active:

- `edit` and `write` are permitted only for the active task's plan file;
- the Plan prompt reserves those mutations for finalizing or explicitly revising the plan, not ordinary conversation or research;
- other `edit` and `write` calls are blocked by the extension;
- bash is not restricted at the permission layer, but the Plan prompt explicitly permits read-only exploration only.

In Build mode, the active plan file is read-only to agent `edit` and `write` calls. The agent must not check off its Markdown items: normal implementation records whole-plan completion through `plan_complete`, while step-by-step execution records progress through `plan_step_complete`. Extension-controlled revisions of unimplemented step instructions remain supported.

This mirrors the intended permission-oriented workflow rather than hiding normal tool schemas.

### Conversational planning

Plan mode follows OpenCode’s standard conversational lifecycle while retaining this extension’s persisted approval flow. The agent can answer informational questions, discuss requirements and tradeoffs, inspect the project with read-only tools, and ask follow-up questions across multiple turns. Ordinary conversation and research do not create or update the plan file and do not invoke `plan_exit`.

Once the request is sufficiently understood and the agent is ready to present the final implementation plan—or the user explicitly asks it to finalize—the agent writes the complete canonical plan and calls `plan_exit`. An existing plan file does not trigger automatic edits during unrelated discussion.

### Minimal verification

Plan and implementation prompts instruct agents to **use the smallest sufficient verification, then stop**. Default to one focused behavioral check using existing repository tools, with an exact command and expected result—not a rigid one-command limit. Add or update a small test when existing coverage misses the change; prose-only edits can use focused inspection. Builds and type-checks are appropriate for some changes but do not by themselves prove runtime behavior.

Additional checks need a concrete uncovered behavior or risk, an observed failure, or an explicit user/repository requirement. Passing planned checks do not automatically trigger full suites, packaging checks, or extra smoke tests. Step-by-step execution reuses still-valid results instead of repeating plan-wide checks; checks requiring later steps are explicitly deferred. Agents report blocked or unperformed checks rather than claiming success.

The same policy is included in Build transitions and clean-session handoffs. These are model instructions, not runtime test limits or guarantees of compliance; repository and release/CI requirements still apply.

## Design and attribution

Pi Plan & Build is an independent extension with its own workflow and UI behavior. Its conversational read-only lifecycle follows OpenCode’s standard Plan agent, while persisted finalization and approval are adapted for Pi. Earlier prompt and transition semantics were informed by OpenCode 1.18.16, and clean-session implementation ideas were informed by the former `pi-plan-mode` extension. The mode-colored transcript rail decorates Pi's exported `UserMessageComponent` because Pi does not currently expose a built-in user-message renderer hook; this compatibility layer is guarded against duplicate installation on reload. This project is not affiliated with either project.

The Plan workflow uses Pi's native exploration tools directly and does not bundle or require subagents.

## Development

```bash
npm test
npm pack --dry-run
```

The tests cover state decoding, safe plan paths, mutation restrictions, deferred transitions, mode/provider/thinking rendering and cycling, optional-UI ownership decisions, conversational Plan guidance, session-based prompt history restoration, complete plan rendering, approval decisions, stop behavior, fresh-session settings and handoff content, question formatting and cancellation, numbered-step and legacy checkbox parsing, step state transitions, safe instruction revisions, and responsive panel rendering.

### Publishing

Releases are published through `.github/workflows/publish.yml`. Bump the version in `package.json`, commit the release, and push a matching semantic-version tag:

```bash
git tag vX.Y.Z
git push origin main vX.Y.Z
```

The tag triggers GitHub Actions to publish the public package to npm with trusted publishing and provenance. The `prepublishOnly` hook runs the test suite before publication.

## License

[MIT](LICENSE)
