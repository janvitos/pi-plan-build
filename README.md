# Pi Plan & Build

**Plan safely, approve explicitly, then implement here or in a clean session.**

A global [Pi coding agent](https://github.com/badlogic/pi-mono) extension that adds persistent **Plan** and **Build** modes, guarded plan-file editing, interactive planning questions, full-plan review, explicit approval, and clean-session implementation handoffs.

## Features

- New sessions start in **Build** mode.
- Bare `Tab` cycles **Build → Plan → Build**, while active autocomplete dropdowns retain Pi's normal Tab completion.
- The composer uses OpenCode prompt-inspired blue/orange mode colors on the rounded top-left border and left rail, complemented by Pi's border color on the right rail and rounded bottom-right border; rounded corners inherit their vertical rail colors while horizontal `╌` segments bridge the borders at both junctions, paired with a light vertical `┆` at the top right and a mode-specific bottom-left transition: thin `┆` in Plan and heavy `┇` in Build. It also includes a mode/model/thinking metadata row; cycling the thinking level updates this row without adding a duplicate status above the composer. The model is shown as `model-id [provider]` (for example, `gpt-5.6-luna [openai]`), with the model ID inheriting the terminal foreground like unselected entries in `/model` and the provider using the footer's dim text color. The footer keeps the remaining path and usage stats without duplicating model metadata.
- `/plan`, `/build`, and the `--plan` startup flag.
- Per-session plans at `~/.pi/agent/plans/<session-id>.md`.
- In Plan mode, built-in `edit` and `write` are restricted to the exact plan file.
- Interactive `question`, `plan_enter`, and `plan_exit` tools.
- Plan mode supports read-only conversation and research across multiple turns, then persists the final plan when it is ready for approval.
- The complete saved plan is rendered in the transcript before approval—without the built-in write preview's truncation.
- Three approval actions:
  - **Switch to Build and implement here**
  - **Start fresh and implement**
  - **Stay in Plan mode**
- Staying in Plan mode—or pressing Escape in the approval dialog—produces a durable acknowledgement and stops the run until the user responds.
- Mode state survives reloads, resumes, and forks.
- When Pi recreates the custom editor, the latest 100 user prompts from the active session branch are restored for Up/Down history navigation.

## Requirements

- Pi `0.84.2` or newer
- Node.js `22.6` or newer for the test command
- TUI or RPC UI support for interactive questions and approval dialogs

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
| `Tab` | Cycle Build and Plan, or accept an active autocomplete selection |
| `/plan` | Select Plan mode |
| `/build` | Select Build mode |
| `pi --plan` | Start a new session in Plan mode |
| `/build-fresh` | Start a pending clean-session implementation manually |

The agent may also enter Plan mode with `plan_enter` when planning or investigation is safer than immediate execution.

### Plan approval

When planning is complete, `plan_exit` displays the entire persisted plan and asks whether to:

1. implement in the current session;
2. start a clean linked implementation session; or
3. stay in Plan mode.

Selecting **Start fresh and implement** stops the current run and automatically dispatches `/build-fresh`. Pi 0.84.2 or newer is required for extension command dispatch from an injected user message. The command creates a linked child session, copies the approved plan to its canonical plan file, preserves the model and thinking level selected for the action, switches it to Build, and starts implementation without transferring the planning conversation.

Selecting **Stay in Plan mode**, or pressing Escape while the approval dialog is open, displays:

> Staying in Plan mode. Let me know when you’re ready to revise or implement the plan.

Both actions leave Plan mode active, stop the agent, and wait for the next user message.

## Plan-mode permissions

Normal tools remain visible so the model can inspect the project. While a Plan run is active:

- `edit` and `write` are permitted only for the canonical session plan file;
- the Plan prompt reserves those mutations for finalizing or explicitly revising the plan, not ordinary conversation or research;
- other `edit` and `write` calls are blocked by the extension;
- bash is not restricted at the permission layer, but the Plan prompt explicitly permits read-only exploration only.

This mirrors the intended permission-oriented workflow rather than hiding normal tool schemas.

### Conversational planning

Plan mode follows OpenCode’s standard conversational lifecycle while retaining this extension’s persisted approval flow. The agent can answer informational questions, discuss requirements and tradeoffs, inspect the project with read-only tools, and ask follow-up questions across multiple turns. Ordinary conversation and research do not create or update the plan file and do not invoke `plan_exit`.

Once the request is sufficiently understood and the agent is ready to present the final implementation plan—or the user explicitly asks it to finalize—the agent writes the complete canonical plan and calls `plan_exit`. An existing plan file does not trigger automatic edits during unrelated discussion.

## Design and attribution

Pi Plan & Build is an independent extension with its own workflow and UI behavior. Its conversational read-only lifecycle follows OpenCode’s standard Plan agent, while persisted finalization and approval are adapted for Pi. Earlier prompt and transition semantics were informed by OpenCode 1.18.16, and clean-session implementation ideas were informed by the former `pi-plan-mode` extension. This project is not affiliated with either project.

The Plan workflow uses Pi's native exploration tools directly and does not bundle or require subagents.

## Development

```bash
npm test
npm pack --dry-run
```

The tests cover state decoding, safe plan paths, mutation restrictions, deferred transitions, mode and provider rendering, conversational Plan guidance, session-based prompt history restoration, complete plan rendering, approval decisions, stop behavior, fresh-session settings and handoff content, and question formatting and cancellation.

### Publishing

Releases are published through `.github/workflows/publish.yml`. Bump the version in `package.json`, commit the release, and push a matching semantic-version tag:

```bash
git tag vX.Y.Z
git push origin main vX.Y.Z
```

The tag triggers GitHub Actions to publish the public package to npm with trusted publishing and provenance. The `prepublishOnly` hook runs the test suite before publication.

## License

[MIT](LICENSE)
