import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { isKeyId, loadShortcutConfig, parseShortcutConfig, saveShortcutPreset, saveShowPlanTitle, SHORTCUT_CONFIG_FILE, SHORTCUT_PRESETS, shortcutPresetLabel } from "./shortcut-config.ts";

test("plan title visibility defaults off and saves safely", () => {
	assert.equal(parseShortcutConfig(undefined).showPlanTitle, false);
	assert.equal(parseShortcutConfig({ showPlanTitle: "true" }).showPlanTitle, false);
	assert.match(parseShortcutConfig({ showPlanTitle: "true" }).warning!, /showPlanTitle must be a boolean/);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-title-visibility-"));
	try {
		const file = path.join(dir, SHORTCUT_CONFIG_FILE);
		fs.writeFileSync(file, JSON.stringify({ unrelated: 42, shortcuts: { toggleMode: [], future: "value" } }));
		for (const enabled of [true, false]) {
			saveShowPlanTitle(dir, enabled);
			assert.equal(loadShortcutConfig(dir).showPlanTitle, enabled);
			const saved = JSON.parse(fs.readFileSync(file, "utf8"));
			assert.equal(saved.unrelated, 42);
			assert.deepEqual(saved.shortcuts, { toggleMode: [], future: "value" });
		}
		saveShowPlanTitle(dir, true);
		saveShortcutPreset(dir, "Disabled");
		assert.equal(loadShortcutConfig(dir).showPlanTitle, true);
		for (const malformed of ["{", "null", "[]", '{"shortcuts":[]}']) {
			fs.writeFileSync(file, malformed);
			assert.throws(() => saveShowPlanTitle(dir, true));
			assert.equal(fs.readFileSync(file, "utf8"), malformed);
		}
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("obsolete small-caps settings are ignored", () => {
	for (const smallCapsPlanTitle of [true, false, "false"]) {
		assert.deepEqual(parseShortcutConfig({ smallCapsPlanTitle, shortcuts: { toggleMode: [] } }), {
			showPlanTitle: false,
			config: { toggleMode: [], toggleModeInEditor: ["tab"] },
		});
	}
});

test("shortcut defaults preserve Tab and Alt+M", () => {
	assert.deepEqual(parseShortcutConfig(undefined), {
		showPlanTitle: false,
		config: {
			toggleMode: ["alt+m"],
			toggleModeInEditor: ["tab"],
		},
	});
});

test("shortcut configuration accepts remapping and explicit disabling", () => {
	const result = parseShortcutConfig({
		shortcuts: {
			toggleMode: "ctrl+alt+m",
			toggleModeInEditor: ["ctrl+shift+m", "f6", "ctrl+shift+m"],
		},
	});

	assert.deepEqual(result, {
		showPlanTitle: false,
		config: {
			toggleMode: ["ctrl+alt+m"],
			toggleModeInEditor: ["ctrl+shift+m", "f6"],
		},
	});
	assert.deepEqual(parseShortcutConfig({ shortcuts: { toggleMode: [] } }).config.toggleMode, []);
});

test("invalid shortcut values use defaults only for the invalid action", () => {
	const result = parseShortcutConfig({
		shortcuts: {
			toggleMode: ["cmd+m"],
			toggleModeInEditor: "ctrl+shift+m",
		},
	});

	assert.deepEqual(result.config, {
		toggleMode: ["alt+m"],
		toggleModeInEditor: ["ctrl+shift+m"],
	});
	assert.match(result.warning ?? "", /shortcuts\.toggleMode/);
	for (const key of ["super+shift+f12", "ctrl+ctrl+m", "ctrl++", "+", "alt+escape"]) {
		assert.equal(isKeyId(key), false, key);
	}
	for (const [key, data] of [["ctrl+shift+m", "\x1b[109;6u"], ["f6", "\x1b[17~"], ["super+k", "\x1b[107;9u"]]) {
		assert.ok(isKeyId(key));
		assert.ok(matchesKey(data!, key), `${key} must be supported by Pi's matcher`);
	}
	const invalidEditor = parseShortcutConfig({ shortcuts: { toggleMode: [], toggleModeInEditor: "ctrl++" } });
	assert.deepEqual(invalidEditor.config, { toggleMode: [], toggleModeInEditor: ["tab"] });
	assert.match(invalidEditor.warning ?? "", /shortcuts\.toggleModeInEditor/);
});

test("global Tab uses the global default and explains the editor-only alternative", () => {
	const result = parseShortcutConfig({ shortcuts: { toggleMode: ["tab"], toggleModeInEditor: [] } });
	assert.deepEqual(result.config, { toggleMode: ["alt+m"], toggleModeInEditor: [] });
	assert.match(result.warning ?? "", /put tab in shortcuts\.toggleModeInEditor/);
});

test("presets round-trip, preserve unrelated settings, and identify custom bindings", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-build-shortcuts-"));
	try {
		const file = path.join(dir, SHORTCUT_CONFIG_FILE);
		fs.writeFileSync(file, JSON.stringify({ unrelated: { enabled: true }, shortcuts: { futureAction: ["f7"] } }));
		for (const [label, config] of Object.entries(SHORTCUT_PRESETS)) {
			assert.equal(saveShortcutPreset(dir, label), file);
			assert.deepEqual(loadShortcutConfig(dir).config, config);
			assert.equal(shortcutPresetLabel(loadShortcutConfig(dir).config), label);
			const saved = JSON.parse(fs.readFileSync(file, "utf8"));
			assert.deepEqual(saved.unrelated, { enabled: true });
			assert.deepEqual(saved.shortcuts.futureAction, ["f7"]);
			assert.deepEqual(fs.readdirSync(dir), [SHORTCUT_CONFIG_FILE], "atomic save leaves no temporary file");
		}
		assert.equal(shortcutPresetLabel({ toggleMode: ["f6"], toggleModeInEditor: [] }), "Custom");
		const newDir = path.join(dir, "new-agent-dir");
		saveShortcutPreset(newDir, "Tab + Alt+M");
		assert.equal(shortcutPresetLabel(loadShortcutConfig(newDir).config), "Tab + Alt+M");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("saving refuses malformed files and reports filesystem failures", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-build-shortcuts-"));
	try {
		const file = path.join(dir, SHORTCUT_CONFIG_FILE);
		for (const malformed of ["{", "[]", '{"shortcuts":[]}']) {
			fs.writeFileSync(file, malformed);
			assert.throws(() => saveShortcutPreset(dir, "Alt+M only"));
			assert.equal(fs.readFileSync(file, "utf8"), malformed);
		}
		// A regular file cannot be used as an agent directory (works even as root).
		assert.throws(() => saveShortcutPreset(file, "Alt+M only"));
		assert.match(loadShortcutConfig(file).warning ?? "", /ENOTDIR/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("shortcut configuration reads the Pi agent directory and fails safely", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-build-shortcuts-"));
	try {
		assert.deepEqual(loadShortcutConfig(dir), {
			showPlanTitle: false,
			config: { toggleMode: ["alt+m"], toggleModeInEditor: ["tab"] },
			path: path.join(dir, SHORTCUT_CONFIG_FILE),
		});
		fs.writeFileSync(path.join(dir, SHORTCUT_CONFIG_FILE), "{", "utf8");
		const invalid = loadShortcutConfig(dir);
		assert.deepEqual(invalid.config, { toggleMode: ["alt+m"], toggleModeInEditor: ["tab"] });
		assert.match(invalid.warning ?? "", /invalid JSON/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
