# Settings and shortcuts

[← README](../README.md)

## Default startup mode

Build is the default startup mode for new sessions. To start new sessions in Plan instead, choose **Default mode → Plan** in `/plan-settings`, or set `defaultMode` directly:

```json
{
  "defaultMode": "plan"
}
```

Only `"build"` and `"plan"` are accepted; any other value warns and falls back to Build. **Default mode** applies to sessions that have no mode recorded on their branch, so it takes effect immediately for the next session without `/reload` and never changes the current session's mode. Override it for a single run with `pi --plan` or `pi --build`.

Startup mode resolves in this order:

1. The mode recorded on the session branch.
2. The `--plan` / `--build` CLI flag (`--plan` wins if both are passed).
3. The `defaultMode` setting.
4. Build.

Restoring or forking a session therefore keeps its recorded mode, and `/reload` is only needed after editing the file by hand.

## Per-mode model and thinking selection

In `/plan-settings`, choose **Per-mode model/thinking → On** to remember separate Plan and Build selections. This is **off by default**. Continue using Pi's normal model picker and thinking controls in each mode; switching modes restores that mode's last pair.

Enabling seeds any missing pair from the current model/thinking level. Disabling leaves the current selection unchanged and retains saved pairs for later use. Preferences are global in `pi-plan-build.json` under `modeSelections`; session restoration preserves the session's actual selection. Direct configuration edits require `/reload`.

Manual mode changes during a run defer automatic model switching until that run settles. Fresh implementation uses the remembered Build pair when enabled. Missing models/authentication produce a warning rather than a silent substitution; select a replacement or disable the feature. Agent-initiated mode transitions stop on selection failure. Pi clamps thinking to supported levels and an adjustment notice explains the effective value.

```json
{
  "modeSelections": {
    "enabled": true,
    "plan": { "provider": "your-provider", "modelId": "your-plan-model", "thinkingLevel": "high" },
    "build": { "provider": "your-provider", "modelId": "your-build-model", "thinkingLevel": "medium" }
  }
}
```

## Question tool

Pi Plan Build provides the structured `question` tool. It is **on by default**; choose **Question tool → Off** in `/plan-settings`, or set it directly:

```json
{
  "questionTool": false
}
```

The setting is read once when the extension loads. `/plan-settings` saves the new value and asks you to run `/reload`; the current session keeps the tool set it started with, because Pi cannot unregister a tool that is already registered. Only `true` and `false` are accepted; any other value warns and stays enabled. Direct file edits require `/reload` too.

With the setting off, a `question` tool supplied by another extension is an ordinary host tool: it is not managed, not filtered out of the mode tool set, and stays available. One API limit follows. Pi requires tool names to be unique across extensions: with the setting **on** and another extension already providing `question`, Pi fails to load this plugin's extension (`Tool "question" conflicts with ...`) while the other extension keeps working — write `"questionTool": false` to run both. Pi has no unregister call, so the setting can only decide what happens at load time; that is why a saved change needs `/reload`. Starting Pi with `"questionTool": false` already written leaves a host `question` tool untouched.

The cancelled-question notice renderer stays registered either way, so entries recorded in earlier sessions keep rendering.

## Stable tool catalog

This is **on by default**. To turn it off, choose **Stable tool catalog → Off** in `/plan-settings`; it applies immediately. You can also set `"stableToolCatalog": false` in `~/.pi/agent/pi-plan-build.json` and run `/reload`. Invalid values warn and fall back to `true`.

When enabled, all six Plan Build lifecycle tools remain visible in a fixed order across modes, attachment changes and step transitions. Visibility is not permission: tools still reject invalid modes, missing attachments and invalid execution state. Plan file guards, step authorization and review approval remain in force. The optional question tool continues to respect `questionTool`.

This stabilizes only this extension's catalog. Tools owned by other extensions remain governed by the live host set; their additions/removals are not suppressed or reversed. Model changes and external tool changes can still invalidate caching. The trade-off is a larger initial catalog and irrelevant tools visible to the model, which may occasionally call one in the wrong mode and receive an error.

It helps most when you switch modes often and use the same model in both. Without it, a mode or plan change alters the tool list, and providers must re-read the whole conversation. It helps little if you mostly work without plans or use different models per mode. If your model often calls plan tools in the wrong mode, turn it off.

Other prompt-cache tips:

- **Same model and thinking level in both modes.** Different models never share a cache, and on some providers (such as Anthropic) a thinking-level change also resets the cached conversation. Keep **Per-mode model/thinking** off, or choose the same pair for both modes, if caching matters more than per-mode models.
- **Anthropic cache lifetime.** Anthropic's cache expires after about 5 minutes of inactivity by default. Pi can request a 1-hour cache with the `PI_CACHE_RETENTION=long` environment variable; cache writes cost more, so this pays off mainly if you often pause between requests.

## Shortcut configuration

`/plan-settings` groups **Tab + Alt+M**, **Alt+M only**, **Disabled**, and **Custom (edit config file)** under the **Shortcuts** submenu. The main menu also offers **Default mode**, **Plan title**, **Question tool**, **Stable tool catalog**, and **Per-mode model/thinking**. Saving preserves unrelated settings; cancellation changes nothing. Malformed JSON is never overwritten. Shortcut changes require `/reload`; the question tool is read at load time, so `/plan-settings` saves it and asks for `/reload`; default mode, title, stable tool catalog, and per-mode selection changes apply without reloading. Direct file edits require `/reload`.

Pi Plan Build reads `~/.pi/agent/pi-plan-build.json` (or `$PI_CODING_AGENT_DIR/pi-plan-build.json`):

```json
{
  "shortcuts": {
    "toggleMode": ["alt+m"],
    "toggleModeInEditor": ["tab"]
  }
}
```

Composer-outline plan titles are **on by default**. Choose **Plan title → Off** in `/plan-settings` to hide them immediately, or **On (default)** to show them again; changes save and apply without reloading extensions. If you edit `"showPlanTitle": true` directly in `pi-plan-build.json`, run `/reload` to load that file change. The preference also controls fallback status titles. Enabled composer titles use **regular-weight, warning-colored text with their original capitalization**, centered on the top outline between the rounded corners with balanced mode-colored dash runs. Saved titles, other title displays, validation labels, and user input keep their original lettering. Agents are guided to write action-led titles: one imperative phrase naming the action, its object, and at most a short goal (for example `Add color to the composer`). Additional requirements and detail belong in scope. The former `smallCapsPlanTitle` setting is ignored and can be removed from existing configuration files.

Each action accepts one Pi key string or an array. `[]` disables it; omitted actions retain defaults. `toggleMode` uses Pi’s global shortcut conflict rules. `toggleModeInEditor` requires the custom composer and yields to open autocomplete. For example, use `"toggleMode": "ctrl+alt+m"` and `"toggleModeInEditor": ["f6"]`.

**Tab tradeoff:** the default replaces Pi’s closed-menu file-completion trigger (`Review READ` + Tab). Choose **Alt+M only** to restore that trigger. Never put bare Tab in global shortcuts: it would intercept open-menu completion too. Avoid assigning a key to both actions if editor-only autocomplete protection matters.

Use Pi `modifier+key` syntax (`ctrl+shift+m`, `f6`; navigation names include `pageUp`/`pageDown`). Unsupported matcher forms such as `+`/`ctrl++`, modified Escape, and modified function keys are rejected. Terminal support determines advanced modifier behavior. Invalid JSON or bindings warn and use defaults for affected actions.

See [Internals](internals.md#presentation-and-ui-compatibility) for composer and extension compatibility details.
