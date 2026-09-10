import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { isKeyId, loadShortcutConfig, parseShortcutConfig, saveShortcutPreset, saveSmallCapsPlanTitle, SHORTCUT_CONFIG_FILE, SHORTCUT_PRESETS, shortcutPresetLabel } from "./shortcut-config.ts";

test("small-caps settings default safely and preserve independent configuration", () => {
	assert.equal(parseShortcutConfig({}).smallCapsPlanTitle, true);
	assert.equal(parseShortcutConfig({ smallCapsPlanTitle: false, shortcuts: [] }).smallCapsPlanTitle, false);
	const invalid = parseShortcutConfig({ smallCapsPlanTitle: "false", shortcuts: { toggleMode: [] } });
	assert.equal(invalid.smallCapsPlanTitle, true);
	assert.deepEqual(invalid.config.toggleMode, []);
	assert.match(invalid.warning!, /smallCapsPlanTitle must be a boolean/);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-title-config-"));
	try {
		const file = path.join(dir, SHORTCUT_CONFIG_FILE);
		fs.writeFileSync(file, JSON.stringify({ other: 42, shortcuts: { toggleMode: [], futureAction: ["f7"] } }));
		for (const enabled of [false, true]) {
			saveSmallCapsPlanTitle(dir, enabled);
			assert.equal(loadShortcutConfig(dir).smallCapsPlanTitle, enabled);
			assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).shortcuts, { toggleMode: [], futureAction: ["f7"] });
		}
		saveSmallCapsPlanTitle(dir, false);
		saveShortcutPreset(dir, "Disabled");
		assert.equal(loadShortcutConfig(dir).smallCapsPlanTitle, false);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).other, 42);
		assert.deepEqual(fs.readdirSync(dir), [SHORTCUT_CONFIG_FILE]);
		for (const malformed of ["{", "[]", "null", '{"shortcuts":[]}']) {
			fs.writeFileSync(file, malformed);
			assert.throws(() => saveSmallCapsPlanTitle(dir, false));
			assert.equal(fs.readFileSync(file, "utf8"), malformed);
		}
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("shortcut defaults preserve Tab and Alt+M", () => {
	assert.deepEqual(parseShortcutConfig(undefined), {
		smallCapsPlanTitle: true,
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
		smallCapsPlanTitle: true,
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
			smallCapsPlanTitle: true,
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
