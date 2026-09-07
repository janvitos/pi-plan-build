import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isKeyId, loadShortcutConfig, parseShortcutConfig, SHORTCUT_CONFIG_FILE } from "./shortcut-config.ts";

test("shortcut defaults preserve Alt+M and leave the editor alone", () => {
	assert.deepEqual(parseShortcutConfig(undefined), {
		config: {
			toggleMode: ["alt+m"],
			toggleModeInEditor: [],
		},
	});
});

test("shortcut configuration accepts remapping and explicit disabling", () => {
	const result = parseShortcutConfig({
		shortcuts: {
			toggleMode: "ctrl+alt+m",
			toggleModeInEditor: ["ctrl+shift+m", "ctrl++", "ctrl+shift+m"],
		},
	});

	assert.deepEqual(result, {
		config: {
			toggleMode: ["ctrl+alt+m"],
			toggleModeInEditor: ["ctrl+shift+m", "ctrl++"],
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
	assert.equal(isKeyId("super+shift+f12"), true);
	assert.equal(isKeyId("ctrl+ctrl+m"), false);
});

test("shortcut configuration reads the Pi agent directory and fails safely", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-build-shortcuts-"));
	try {
		assert.deepEqual(loadShortcutConfig(dir), {
			config: { toggleMode: ["alt+m"], toggleModeInEditor: [] },
			path: path.join(dir, SHORTCUT_CONFIG_FILE),
		});
		fs.writeFileSync(path.join(dir, SHORTCUT_CONFIG_FILE), "{", "utf8");
		const invalid = loadShortcutConfig(dir);
		assert.deepEqual(invalid.config, { toggleMode: ["alt+m"], toggleModeInEditor: [] });
		assert.match(invalid.warning ?? "", /invalid JSON/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
