# Pi Plan & Build

**Plan safely, approve explicitly, then implement here or in a clean session.**

A global [Pi coding agent](https://github.com/badlogic/pi-mono) extension that adds persistent **Plan** and **Build** modes, guarded plan-file editing, interactive planning questions, full-plan review, explicit approval, and clean-session implementation handoffs.

## Features

- New sessions start in **Build** mode.
- Bare `Tab` cycles **Build → Plan → Build** and replaces normal Tab autocomplete.
- `[Build]` and `[Plan]` status indicators in Pi's footer.
- `/plan`, `/build`, and the `--plan` startup flag.
- Per-session plans at `~/.pi/agent/plans/<session-id>.md`.
- In Plan mode, built-in `edit` and `write` are restricted to the exact plan file.
- Interactive `question`, `plan_enter`, and `plan_exit` tools.
- The complete saved plan is rendered in the transcript before approval—without the built-in write preview's truncation.
- Three approval actions:
  - **Switch to Build and implement here**
  - **Start fresh and implement**
  - **Stay in Plan mode**
- Staying in Plan mode produces a durable acknowledgement and stops the run until the user responds.
- Mode state survives reloads, resumes, and forks.

## Requirements

- Pi `0.84.1` or newer
- Node.js `22.6` or newer for the test command
- TUI or RPC UI support for interactive questions and approval dialogs

## Install

Install directly from GitHub:

```bash
pi install git:github.com/janvitos/pi-plan-build
```

Then start a new Pi process, or run `/reload` in an existing session.

### Local development install

```bash
git clone https://github.com/janvitos/pi-plan-build.git ~/src/pi-plan-build
ln -s ~/src/pi-plan-build ~/.pi/agent/extensions/pi-plan-build
```

Do not install both the Git package and the local symlink at the same time; that would load the extension twice and cause command/flag conflicts.

## Usage

| Action | Result |
| --- | --- |
| `Tab` | Cycle Build and Plan |
| `/plan` | Select Plan mode |
| `/build` | Select Build mode |
| `pi --plan` | Start a new session in Plan mode |
| `/build-fresh` | Confirm a pending clean-session implementation |

The agent may also enter Plan mode with `plan_enter` when planning or investigation is safer than immediate execution.

### Plan approval

When planning is complete, `plan_exit` displays the entire persisted plan and asks whether to:

1. implement in the current session;
2. prepare a clean linked implementation session; or
3. stay in Plan mode.

Selecting **Start fresh and implement** stops the current run and pre-fills `/build-fresh`. Press Enter to confirm. Pi only exposes session creation to user-invoked command contexts, so this confirmation is required. The command creates a linked child session, copies the approved plan to its canonical plan file, switches it to Build, and starts implementation without transferring the planning conversation.

Selecting **Stay in Plan mode** displays:

> Staying in Plan mode. Let me know when you’re ready to revise or implement the plan.

The agent then stops and waits for the next user message.

## Plan-mode permissions

Normal tools remain visible so the model can inspect the project. While a Plan run is active:

- `edit` and `write` are permitted only for the canonical session plan file;
- other `edit` and `write` calls are blocked by the extension;
- bash is not restricted at the permission layer, but the Plan prompt explicitly permits read-only exploration only.

This mirrors the intended permission-oriented workflow rather than hiding normal tool schemas.

## Design and attribution

Pi Plan & Build is an independent extension with its own workflow and UI behavior. Its original mode prompts and transition semantics were informed by OpenCode 1.18.16, while clean-session implementation ideas were informed by the former `pi-plan-mode` extension. Those behaviors have since been adapted and extended for Pi; this project is not affiliated with either project.

The Plan workflow uses Pi's native exploration tools directly and does not bundle or require subagents.

## Development

```bash
npm test
```

The tests cover state decoding, safe plan paths, mutation restrictions, deferred transitions, complete plan rendering, approval decisions, stop behavior, fresh-session handoff content, and question formatting.

## License

[MIT](LICENSE)
