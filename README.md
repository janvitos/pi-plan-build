# Pi Plan & Build

**Plan safely, approve explicitly, then implement here or in a clean session.**

A [Pi coding agent](https://github.com/earendil-works/pi-mono) extension that separates planning from implementation without making every small fix a formal project.

- Persistent **Plan/Build** modes and one current unfinished plan.
- Complete plan review before implementation, with a clean-session option.
- Optional step-by-step execution—with or without a sidebar.
- Interactive questions, explicit completion, and outstanding validation tracking.
- Optional remembered model/thinking selections for each mode.

## Install

Requires **Pi 0.84.2+** and a **TUI or RPC client** for interactive questions and approval.

```bash
pi install npm:@janvitos/pi-plan-build
# Or:
pi install git:github.com/janvitos/pi-plan-build
```

Restart Pi or run `/reload`. Do not load multiple npm/Git/local copies simultaneously.

[Local development and release instructions →](docs/development.md)

## Quick start

1. Start in **Build** for ordinary coding and discussion. Small fixes need no plan.
2. Select **Plan** with `/plan`, `Alt+M`, or editor `Tab`. Explore and discuss; entering Plan does not create a task or write a file. Plan entry is user-controlled—the agent cannot route a Build request into Plan.
3. Ask for a plan or accept a concrete proposed change. The agent investigates, saves the plan, and presents it for review. Accepting scope does **not** authorize implementation.
4. Choose **implement here**, **start fresh and implement**, or **step by step**. Choose **stay in Plan** or press Escape to stop and wait.
5. After implementation and required checks, the agent records completion. Essential user-only validation keeps the plan open with clear instructions; optional feedback does not block completion.

One plan stays current through discussion, mode changes, and revisions. Complete it or explicitly abandon it before starting another. Abandonment preserves the file but does not imply success or allow resumption.

[Workflow, approval, and validation →](docs/workflow.md)

## Commands and shortcuts

| Action | Purpose |
| --- | --- |
| `Alt+M` | Toggle Plan/Build globally |
| `Tab` | Toggle in the custom composer when autocomplete is closed; accept a suggestion when open |
| `/plan` / `/build` | Select a mode |
| `pi --plan` | Start in Plan for one run |
| `pi --build` | Start in Build for one run |
| `/plan new` | Start a plan when none is unfinished |
| `/plan list` | Show the current plan's brief status |
| `/plan show` | Read the current plan, progress, and outstanding validation |
| `/plan history` | Read completed/abandoned plans tracked on this session branch |
| `/plan done` | Explicitly mark work complete in Build |
| `/plan abandon` | Confirm abandonment without deleting the plan file |
| `/build-fresh` | Retry a pending approved clean-session handoff |
| `/plan-settings` | Configure the default mode, shortcuts, titles, and per-mode model/thinking memory |

Lifecycle and inspection commands require an idle agent. `/plan show` and `/plan history` do not require a model turn or start implementation.

## Settings

Open `/plan-settings`:

| Setting | Default | Behavior |
| --- | --- | --- |
| Default mode | Build | Startup mode for new sessions; the current session is unchanged |
| Shortcuts | Tab + Alt+M | Open its submenu to choose Alt+M only, disable shortcuts, or configure custom keys; reload to apply |
| Plan title | Off | Show the current task's title in the composer; applies immediately |
| Per-mode model/thinking | Off | Remember separate Plan and Build selections; applies immediately |
| Question tool | On | Provide this extension's structured `question` tool; off leaves a `question` tool from another extension alone |

When per-mode memory is enabled, use Pi's normal model picker and thinking controls in each mode. Switching modes restores that mode's last pair. Disabling leaves the current selection unchanged.

**Tab tradeoff:** the default replaces Pi's closed-menu file-completion trigger. Choose **Alt+M only** to restore it.

Configuration lives at `~/.pi/agent/pi-plan-build.json` (or `$PI_CODING_AGENT_DIR/pi-plan-build.json`). Direct file edits require `/reload`; malformed JSON is never overwritten by settings saves.

[Configuration examples, model-switching behavior, and shortcut details →](docs/settings.md)

## Screenshots

### Plan

![Pi Plan mode composer](docs/images/plan.png)

### Build

![Pi Build mode composer](docs/images/build.png)

The composer shows mode, model, provider, and thinking level. Plan titles are optional; submitted prompts retain their original mode-colored rail.

### Step-by-step execution

![Pi step-by-step plan execution panel](docs/images/step-by-step.png)

Say **“Proceed”** to start a ready step. The agent implements that step, verifies it, and waits before the next. Use ordinary prompts to pause, resume, revise, or skip; use `/plan show` to inspect progress.

The optional sidebar needs fullscreen TUI and at least **132 columns**. Step execution also works in regular/narrow TUI and RPC without it.

[Step format, controls, and sidebar setup →](docs/workflow.md#step-by-step-execution-experimental)

## Important limits

- **Plan is not a sandbox.** Built-in edit/write calls are restricted to the attached canonical plan file. Bash/powershell and other tools rely on read-only guidance in ordinary Plan mode—not comprehensive mutation enforcement.
- **Build protects tracked plan files** from built-in edit/write changes. Completion is recorded separately; guarded step-instruction revisions remain supported.
- **Manual mid-run mode changes are deferred.** The composer shows the selected mode while the current run retains its effective permissions. Automatic per-mode model switching is deferred too.
- **Approval checks freshness during the review dialog**, not ongoing implementation drift. Separate deployment/restart approvals still apply.
- **Verification summaries are reports, not harness-certified proof.** Missing summaries do not mean checks passed.
- If another extension owns the editor or fullscreen layout, optional UI degrades rather than replacing it. Core workflows remain available.

## Documentation

- [Workflow](docs/workflow.md): task boundaries, approval, clean sessions, completion, validation, and step execution.
- [Settings](docs/settings.md): default startup mode, shortcuts, titles, and remembered model/thinking selections.
- [Internals](docs/internals.md): persistence, branch/fork handling, context, permission limits, and UI compatibility.
- [Development](docs/development.md): local setup, tests, and release procedures.

## Attribution and license

Independent of Pi and OpenCode. Conversational read-only planning follows OpenCode's Plan agent; persisted finalization/approval are Pi adaptations. Earlier semantics were informed by OpenCode 1.18.16 and clean-session handoffs by the former `pi-plan-mode` extension. No bundled subagents are required.

[MIT](LICENSE)
