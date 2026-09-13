# Persistence, permissions, and UI internals

[← README](../README.md)

## Persistence and model context

One versioned collection stores records, the current attachment, and the allocation high-water mark; no duplicate current-plan or execution mirrors are saved. Meaningful transitions save a snapshot once; identical snapshots, reads, lists, and ordinary model requests do not. Restoration retains completed/abandoned records, unsaved metadata/outcomes, and step progress. Old detached records from the former multi-plan workflow remain untouched as hidden inert history: they are not listed, counted, resumed, selected, or migrated. Malformed modern state is reported and disables mutations instead of falling back to partial data.

Reload/tree navigation restores branch state while allocation honors the session-wide high-water mark and existing files. Forks copy tracked files to child paths without overwriting source files. Fresh implementation transfers **only the current approved plan**, not historical records or planning conversation.

The `context` hook refreshes one current mode/task block before each model request. Because Pi converts custom messages to user-role messages, this background block is placed before the latest actual user request (or at the beginning if none remains), never after its tool results. It requires no acknowledgment. Obsolete extension-owned reminders are filtered from outgoing context without deleting transcript history. Build with no current plan receives none. Current contexts include outcome facts and, when applicable, executable-step or execution-waiting restrictions. Awaiting-validation context includes the exact required user action until it is resolved. File facts refresh at restoration, current selection, canonical edit/write results, and user-run boundaries; action-time safety checks do not rely on display caches.

## Presentation and UI compatibility

The rounded composer uses the current theme’s `warning` color in Plan and `thinkingLow` in Build on the top-left border and continuous solid `│` left rail. The right rail uses Pi’s border color. The unfinished attached task’s title sits in the top border; mode, model, provider, and thinking level sit in the bottom border. Text truncates to terminal width. Model/thinking changes update the display live.

User-visible text follows one semantic color contract. Text that asks the user to act uses the theme’s `accent` color in bold through one shared helper: the awaiting-validation heading, step-kickoff guidance, cancelled-question notice, `stay`/`step-by-step` mode announcements, and step-control clauses that await instruction or approval. `success` marks confirmed state changes; `muted` marks pending activity, no-ops, inventory, paths and other bookkeeping, and legacy or unknown renderer details; `warning` marks cautions and degraded or unfinished states; and `error` marks failures. Mixed tool results style each clause separately—for example, a completed-step clause is `success` while its following wait-for-instruction clause is bold `accent`. Explanatory prose and user-provided content remain ordinary text.

After one empty line, the awaiting-validation instruction body uses regular-color Markdown, so it can wrap naturally and present multiple checks as bullets without turning a paragraph into an accent block. The heading and body use Pi's standard one-column transcript inset, and list markers keep the normal conversation `mdListBullet` styling. Bold keeps action cues legible when a theme places `accent` near body text. `/plan show`, `/plan history`, plan reviews, and completion summaries remain plain Markdown reports. Composer mode chrome, transcript rails, and panel state markers retain their dedicated mode/status colors. TUI/RPC notifications use Pi's available `info`, `warning`, and `error` levels: successful and neutral notices use `info`, cautions use `warning`, and failures use `error` because notifications do not expose `success` or `accent` levels.

When enabled, titles stay through mode changes and execution pauses, disappear on completion/abandonment, and change only when the task identity changes. Validation notices belong in the main chat, never in the composer title or border. Metadata takes precedence over the first nonempty top-level Markdown heading outside fenced code. An existing unfinished file without a title displays `Untitled task`; empty reservations do not. No scope is inferred from the display fallback.

Submitted user messages retain their original mode-colored rail after mode changes and session restoration. Recreated custom editors restore the latest 100 active-branch user prompts for Up/Down history. Pi Plan Build leaves the footer untouched; its keyed status is a fallback when another extension owns the composer.

Compatible editor decorators may invoke Plan Build’s editor factory and retain its composer. A preexisting editor, non-composing replacement, or competing fullscreen layout triggers one warning and reduced optional UI rather than replacing the other owner. Core modes, tools, shortcuts, and restored step progress remain available. Teardown restores only UI slots still owned by Plan Build.

The guarded transcript-rail integration decorates Pi's exported `UserMessageComponent` because no built-in user-message renderer hook exists.

The step-panel layout uses public fullscreen primitives plus a guarded read of the runtime layout root, since Pi's API currently exposes a setter but no getter. Ownership is checked before installation and teardown.

## Outcome reconciliation

A normal saved-plan Build run can receive **one** hidden outcome-reconciliation reminder after approved implementation or a successful project edit/write. It requires a normal terminal response and no recorded outcome. Errors, interruptions, pending input, work without a current plan, conversation-only turns, Plan, and step execution do not trigger it. The reminder authorizes no more implementation/tests and infers no success. Its instruction is visible only during its live bookkeeping follow-up, including the final response after recording an outcome. It expires when that follow-up settles, when a new user message arrives, or when the plan/mode changes; restoration never reactivates it. Its consumed marker is saved before dispatch, preventing replay across restoration; ignoring it leaves the plan unfinished without looping. Shell-only work outside approval may not arm it, so explicit agent finishing remains the primary contract.

Tool output stays compact and preserves errors even during partial output. Expanded inventory and Markdown completion summaries retain specialized rendering. Interactive `question` supports structured choices and custom answers when the optional `questionTool` setting is enabled; its registration and active-tool injection are skipped when that setting is off, while the cancelled-question entry renderer stays registered so restored notices keep rendering. Hidden model guidance is hidden in the normal UI, not inaccessible through session/API data.

## Permission boundary

Plan guidance allows only observation, analysis, discussion, and planning. Built-in edit/write calls may target **only the attached canonical plan path**, and only finalization or explicitly requested revision is appropriate. Other tools remain visible for exploration. Bash/powershell are not sandboxed in ordinary Plan mode: the read-only requirement is model guidance, not arbitrary shell classification.

Build keeps tracked Markdown read-only; completion belongs in extension state. Edit/write guards normalize Pi path forms (including `@` and `~`) and resolve filesystem symlink aliases, including existing parents of new files. Unresolvable targets fail closed. These guards are not an arbitrary-shell sandbox or protection against adversarial filesystem races. Extension-controlled revisions of unimplemented step instructions remain supported and share Pi’s file-mutation queue.

See [Workflow](workflow.md) for approval, validation, RPC review, and step-execution behavior. See [Settings](settings.md) for user configuration.
