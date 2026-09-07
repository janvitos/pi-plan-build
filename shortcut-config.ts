import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";

export const SHORTCUT_CONFIG_FILE = "pi-plan-build.json";

const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz",
	..."0123456789",
	"`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?",
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end", "pageUp", "pageDown", "up", "down", "left", "right",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

export interface ShortcutConfig {
	toggleMode: KeyId[];
	toggleModeInEditor: KeyId[];
}

export interface LoadedShortcutConfig {
	config: ShortcutConfig;
	path: string;
	warning?: string;
}

const DEFAULT_CONFIG: ShortcutConfig = {
	toggleMode: ["alt+m"],
	toggleModeInEditor: ["tab"],
};

export const SHORTCUT_PRESETS: Record<string, ShortcutConfig> = {
	"Tab + Alt+M": DEFAULT_CONFIG,
	"Alt+M only": { toggleMode: ["alt+m"], toggleModeInEditor: [] },
	"Disabled": { toggleMode: [], toggleModeInEditor: [] },
};

export function shortcutPresetLabel(config: ShortcutConfig): string {
	return Object.entries(SHORTCUT_PRESETS).find(([, preset]) =>
		(["toggleMode", "toggleModeInEditor"] as const).every((action) =>
			config[action].length === preset[action].length && config[action].every((key) => preset[action].includes(key)),
		),
	)?.[0] ?? "Custom";
}

function cloneDefaultConfig(): ShortcutConfig {
	return {
		toggleMode: [...DEFAULT_CONFIG.toggleMode],
		toggleModeInEditor: [...DEFAULT_CONFIG.toggleModeInEditor],
	};
}

export function isKeyId(value: unknown): value is KeyId {
	if (typeof value !== "string" || value.length === 0) return false;
	if (BASE_KEYS.has(value)) return true;

	for (const key of BASE_KEYS) {
		const suffix = `+${key}`;
		if (!value.endsWith(suffix)) continue;
		// Pi's matcher currently rejects modified Escape and function keys.
		if (key === "escape" || key === "esc" || /^f\d+$/.test(key)) return false;
		const modifiers = value.slice(0, -suffix.length).split("+");
		return modifiers.length > 0
			&& modifiers.every((modifier) => MODIFIERS.has(modifier))
			&& new Set(modifiers).size === modifiers.length;
	}
	return false;
}

function parseShortcutList(value: unknown, name: keyof ShortcutConfig): {
	shortcuts: KeyId[];
	warning?: string;
} {
	if (typeof value === "string") value = [value];
	if (!Array.isArray(value) || !value.every(isKeyId)) {
		return {
			shortcuts: [...DEFAULT_CONFIG[name]],
			warning: `shortcuts.${name} must be a Pi key string or an array of Pi key strings`,
		};
	}
	if (name === "toggleMode" && value.includes("tab")) {
		return {
			shortcuts: [...DEFAULT_CONFIG[name]],
			warning: "put tab in shortcuts.toggleModeInEditor, not shortcuts.toggleMode, to preserve open-menu autocomplete",
		};
	}
	return { shortcuts: [...new Set(value)] };
}

export function parseShortcutConfig(value: unknown): {
	config: ShortcutConfig;
	warning?: string;
} {
	if (value === undefined) return { config: cloneDefaultConfig() };
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { config: cloneDefaultConfig(), warning: "the file must contain a JSON object" };
	}

	const shortcuts = (value as { shortcuts?: unknown }).shortcuts;
	if (shortcuts === undefined) return { config: cloneDefaultConfig() };
	if (!shortcuts || typeof shortcuts !== "object" || Array.isArray(shortcuts)) {
		return { config: cloneDefaultConfig(), warning: "shortcuts must be a JSON object" };
	}

	const source = shortcuts as Partial<Record<keyof ShortcutConfig, unknown>>;
	const toggleMode = source.toggleMode === undefined
		? { shortcuts: [...DEFAULT_CONFIG.toggleMode] }
		: parseShortcutList(source.toggleMode, "toggleMode");
	const toggleModeInEditor = source.toggleModeInEditor === undefined
		? { shortcuts: [...DEFAULT_CONFIG.toggleModeInEditor] }
		: parseShortcutList(source.toggleModeInEditor, "toggleModeInEditor");
	const warnings = [toggleMode.warning, toggleModeInEditor.warning].filter((warning): warning is string => warning !== undefined);

	return {
		config: {
			toggleMode: toggleMode.shortcuts,
			toggleModeInEditor: toggleModeInEditor.shortcuts,
		},
		...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Preserve unrelated settings and never replace malformed configuration with defaults. */
export function saveShortcutPreset(agentDir: string, presetName: string): string {
	if (!Object.hasOwn(SHORTCUT_PRESETS, presetName)) throw new Error("Unknown shortcut preset");
	const configPath = path.join(agentDir, SHORTCUT_CONFIG_FILE);
	let document: unknown = {};
	try {
		document = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!isObject(document) || (document.shortcuts !== undefined && !isObject(document.shortcuts))) {
		throw new Error("The configuration and shortcuts must be JSON objects; fix the file before saving a preset");
	}
	const next = {
		...document,
		shortcuts: { ...(document.shortcuts as Record<string, unknown> | undefined), ...SHORTCUT_PRESETS[presetName] },
	};
	fs.mkdirSync(agentDir, { recursive: true });
	const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		fs.renameSync(temporaryPath, configPath);
	} finally {
		fs.rmSync(temporaryPath, { force: true });
	}
	return configPath;
}

export function loadShortcutConfig(agentDir: string): LoadedShortcutConfig {
	const configPath = path.join(agentDir, SHORTCUT_CONFIG_FILE);
	let content: string;
	try {
		content = fs.readFileSync(configPath, "utf8");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { config: cloneDefaultConfig(), path: configPath };
		}
		return {
			config: cloneDefaultConfig(),
			path: configPath,
			warning: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		return { ...parseShortcutConfig(JSON.parse(content)), path: configPath };
	} catch (error: unknown) {
		return {
			config: cloneDefaultConfig(),
			path: configPath,
			warning: `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
		};
	}
}
