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
- `Alt+M` cycles **Build → Plan → Build** in every TUI setup. Pi Plan Build leaves Pi's native `Tab` autocomplete behavior unchanged by default; its mode shortcuts are configurable per user.
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
- **Experimental:** In fullscreen TUI, valid checklist plans also offer **Implement step by step** when Pi Plan Build owns the optional fullscreen layout: a passive, non-overlapping docked right panel keeps the plan visible while natural-language prompts gate steps and report completed work. The panel is visual-only and never captures keyboard input. This feature is still under active development.
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
| Configured editor shortcut | Cycle modes only in Pi Plan Build's custom composer, without intercepting an open autocomplete selection |
| `/plan` | Resume the unfinished plan, or select a new plan file after completion |
| `/plan new` | Start a separate task in Plan mode, preserving previous plan files and clearing previous step execution |
| `/plan done` | In Build mode, explicitly mark the saved plan's implementation complete |
| `/build` | Select Build mode |
| `pi --plan` | Start a new session in Plan mode |
| `/build-fresh` | Start a pending clean-session implementation manually |

### Shortcut configuration

Pi Plan Build reads its user configuration from `~/.pi/agent/pi-plan-build.json` (or `$PI_CODING_AGENT_DIR/pi-plan-build.json`). The default behavior is equivalent to:

```json
{
  "shortcuts": {
    "toggleMode": ["alt+m"],
    "toggleModeInEditor": []
  }
}
```

`toggleMode` works in every TUI setup. `toggleModeInEditor` works only while Pi Plan Build's custom composer is active. Each action accepts one Pi key string or an array of keys. Use an empty array to disable that action; disable both to remove every Plan Build mode shortcut.

```json
{
  "shortcuts": {
    "toggleMode": "ctrl+alt+m",
    "toggleModeInEditor": ["ctrl+shift+m"]
  }
}
```

Use Pi's `modifier+key` syntax, such as `ctrl+alt+m`, `shift+tab`, or `f6`. A configured editor key is ignored while Pi displays an autocomplete list, so the normal completion key still accepts the selected item. Configure `"tab"` only when you intentionally want it to switch modes whenever autocomplete is not already open. Run `/reload` after editing the file. Invalid JSON or key strings show a warning and use safe defaults for the affected action.

The agent may also enter Plan mode with `plan_enter` when planning or investigation is safer than immediate execution.

### Plan lifecycle

One task uses one plan file across discussion, revisions, approval, and temporary mode changes. Approval or the end of an agent turn does **not** mark implementation complete. For normal Build execution, the agent calls `plan_complete` after finishing implementation and required verification; `/plan done` is the manual equivalent. Completing the final step in step-by-step execution also marks the plan complete. The next entry into Plan mode selects a new numbered file without modifying the old one.

Use `/plan new` for an unrelated task before the current plan is finished. It preserves existing files but clears the previous step-by-step execution and pending fresh-session handoff. `/plan new` and `/plan done` require an idle agent. Cancelling step execution does not mark a plan complete.

Plan files are written only when finalizing or revising, not merely when selecting a new task. Reload/resume restores the active file and lifecycle; forks copy the tracked plan into the child session's own file. Legacy unnumbered files are retained without renaming.

### Plan approval

When planning is complete, `plan_exit` displays the entire persisted plan and asks whether to:

1. implement in the current session;
2. start a clean linked implementation session;
3. stay in Plan mode; or
4. **experimentally implement step by step** in fullscreen TUI when the plan contains a valid checklist and no other extension owns the optional editor/layout UI.

Selecting **Start fresh and implement** stops the current run and automatically dispatches `/build-fresh`. Pi 0.84.2 or newer is required for extension command dispatch from an injected user message. The command creates a linked child session, copies the approved plan to its canonical plan file, preserves the model and thinking level selected for the action, switches it to Build, and starts implementation without transferring the planning conversation.

Selecting **Stay in Plan mode**, or pressing Escape while the approval dialog is open, displays:

> Staying in Plan mode. Let me know when you’re ready to revise or implement the plan.

Both actions leave Plan mode active, stop the agent, and wait for the next user message.

### Step-by-step execution details (Experimental)

> **Experimental feature:** Step-by-step execution is still being developed. Expect UI and workflow changes, and please report issues or unexpected behavior.

When Pi uses `"tuiMode": "fullscreen"`, Pi Plan Build still owns its custom editor/layout UI, and the saved plan contains top-level `- [ ]` items under `## Implementation Steps`, `plan_exit` offers the additional **Implement step by step** approval action. This is opt-in per plan; it does not replace either one-shot implementation option or **Stay in Plan mode**.

The passive 64-column right panel reserves terminal columns, so the transcript and editor reflow instead of being covered. Long step instructions and panel guidance wrap instead of being clipped. It never accepts focus or keyboard input and collapses below 132 terminal columns. The panel is a visual status aid only; all control happens through ordinary prompts. Its guidance remains visible, and the main transcript says, “Awaiting your instructions.” The agent interprets intent contextually, so these are examples rather than required commands:

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

## Plan-mode permissions

Normal tools remain visible so the model can inspect the project. While a Plan run is active:

- `edit` and `write` are permitted only for the active task's plan file;
- the Plan prompt reserves those mutations for finalizing or explicitly revising the plan, not ordinary conversation or research;
- other `edit` and `write` calls are blocked by the extension;
- bash is not restricted at the permission layer, but the Plan prompt explicitly permits read-only exploration only.

This mirrors the intended permission-oriented workflow rather than hiding normal tool schemas.

### Conversational planning

Plan mode follows OpenCode’s standard conversational lifecycle while retaining this extension’s persisted approval flow. The agent can answer informational questions, discuss requirements and tradeoffs, inspect the project with read-only tools, and ask follow-up questions across multiple turns. Ordinary conversation and research do not create or update the plan file and do not invoke `plan_exit`.

Once the request is sufficiently understood and the agent is ready to present the final implementation plan—or the user explicitly asks it to finalize—the agent writes the complete canonical plan and calls `plan_exit`. An existing plan file does not trigger automatic edits during unrelated discussion.

## Design and attribution

Pi Plan & Build is an independent extension with its own workflow and UI behavior. Its conversational read-only lifecycle follows OpenCode’s standard Plan agent, while persisted finalization and approval are adapted for Pi. Earlier prompt and transition semantics were informed by OpenCode 1.18.16, and clean-session implementation ideas were informed by the former `pi-plan-mode` extension. The mode-colored transcript rail decorates Pi's exported `UserMessageComponent` because Pi does not currently expose a built-in user-message renderer hook; this compatibility layer is guarded against duplicate installation on reload. This project is not affiliated with either project.

The Plan workflow uses Pi's native exploration tools directly and does not bundle or require subagents.

## Development

```bash
npm test
npm pack --dry-run
```

The tests cover state decoding, safe plan paths, mutation restrictions, deferred transitions, mode/provider/thinking rendering and cycling, optional-UI ownership decisions, conversational Plan guidance, session-based prompt history restoration, complete plan rendering, approval decisions, stop behavior, fresh-session settings and handoff content, question formatting and cancellation, structured checklist parsing, step state transitions, safe instruction revisions, and responsive panel rendering.

### Publishing

Releases are published through `.github/workflows/publish.yml`. Bump the version in `package.json`, commit the release, and push a matching semantic-version tag:

```bash
git tag vX.Y.Z
git push origin main vX.Y.Z
```

The tag triggers GitHub Actions to publish the public package to npm with trusted publishing and provenance. The `prepublishOnly` hook runs the test suite before publication.

## License

[MIT](LICENSE)
