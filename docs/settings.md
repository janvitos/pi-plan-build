# Settings and shortcuts

[← README](../README.md)

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

## Shortcut configuration

`/plan-settings` groups **Tab + Alt+M**, **Alt+M only**, **Disabled**, and **Custom (edit config file)** under the **Shortcuts** submenu. The main menu also offers **Plan title** and **Per-mode model/thinking**. Saving preserves unrelated settings; cancellation changes nothing. Malformed JSON is never overwritten. Shortcut changes require `/reload`; title and per-mode selection toggles apply immediately. Direct file edits require `/reload`.

Pi Plan Build reads `~/.pi/agent/pi-plan-build.json` (or `$PI_CODING_AGENT_DIR/pi-plan-build.json`):

```json
{
  "shortcuts": {
    "toggleMode": ["alt+m"],
    "toggleModeInEditor": ["tab"]
  }
}
```

Composer-outline plan titles are **off by default**. Enable **Plan title → On** in `/plan-settings`; it saves and applies immediately without reloading extensions. Choose **Off (default)** to hide it immediately. If you edit `"showPlanTitle": true` directly in `pi-plan-build.json`, run `/reload` to load that file change. The preference also controls fallback status titles. Enabled composer titles use **regular lowercase, warning-colored text**. Saved titles, other title displays, validation labels, and user input keep their original lettering. Agents are guided to use concise, descriptive plan titles that make the task recognizable when returning to the session: include context needed for clarity, omit filler and unnecessary detail, and never sacrifice meaning merely to shorten the title. The former `smallCapsPlanTitle` setting is ignored and can be removed from existing configuration files.

Each action accepts one Pi key string or an array. `[]` disables it; omitted actions retain defaults. `toggleMode` uses Pi’s global shortcut conflict rules. `toggleModeInEditor` requires the custom composer and yields to open autocomplete. For example, use `"toggleMode": "ctrl+alt+m"` and `"toggleModeInEditor": ["f6"]`.

**Tab tradeoff:** the default replaces Pi’s closed-menu file-completion trigger (`Review READ` + Tab). Choose **Alt+M only** to restore that trigger. Never put bare Tab in global shortcuts: it would intercept open-menu completion too. Avoid assigning a key to both actions if editor-only autocomplete protection matters.

Use Pi `modifier+key` syntax (`ctrl+shift+m`, `f6`; navigation names include `pageUp`/`pageDown`). Unsupported matcher forms such as `+`/`ctrl++`, modified Escape, and modified function keys are rejected. Terminal support determines advanced modifier behavior. Invalid JSON or bindings warn and use defaults for affected actions.

See [Internals](internals.md#presentation-and-ui-compatibility) for composer and extension compatibility details.
