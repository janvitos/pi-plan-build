import type { Mode } from "./utils.ts";

const OSC133_PREFIX = /^((?:\x1b\]133;[ABC]\x07)*)/u;
const PATCH_KEY = Symbol.for("@janvitos/pi-plan-build:user-message-rail");

export interface TranscriptModeRecord {
	text: string;
	mode: Mode;
}

interface UserMessageLike {
	text?: unknown;
	render(width: number): string[];
}

interface UserMessageClass {
	prototype: UserMessageLike;
}

interface RailPatchState {
	originalRender: (this: UserMessageLike, width: number) => string[];
	componentModes: WeakMap<object, Mode>;
	resolver: TranscriptModeResolver;
	formatRail: (mode: Mode, glyph: string) => string;
	getFallbackMode: () => Mode;
	glyph: string;
	owner?: symbol;
}

export interface UserMessageRailController {
	activate(): void;
	setTranscript(records: readonly TranscriptModeRecord[]): void;
	addMessage(text: string, mode: Mode): void;
	deactivate(): void;
}

export class TranscriptModeResolver {
	private records: TranscriptModeRecord[] = [];
	private assigned = 0;

	setTranscript(records: readonly TranscriptModeRecord[]): void {
		this.records = [...records];
		this.assigned = 0;
	}

	addMessage(text: string, mode: Mode): void {
		if (!text) return;
		this.records.push({ text, mode });
	}

	resolve(text: string, fallback: Mode): Mode {
		if (this.records.length === 0) {
			this.assigned++;
			return fallback;
		}

		const start = this.assigned % this.records.length;
		for (let offset = 0; offset < this.records.length; offset++) {
			const index = (start + offset) % this.records.length;
			const record = this.records[index]!;
			if (record.text !== text) continue;
			this.assigned += offset + 1;
			return record.mode;
		}

		this.assigned++;
		return fallback;
	}
}

export function extractUserMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("");
}

export function collectTranscriptModeRecords(
	entries: readonly unknown[],
	options: {
		initialMode?: Mode;
		stateTypes: ReadonlySet<string>;
		decodeState(data: unknown): { selectedMode: Mode } | undefined;
		displayText(text: string): string | undefined;
	},
): TranscriptModeRecord[] {
	let mode = options.initialMode ?? "build";
	const records: TranscriptModeRecord[] = [];

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as {
			type?: unknown;
			customType?: unknown;
			data?: unknown;
			message?: { role?: unknown; content?: unknown };
		};
		if (
			candidate.type === "custom" &&
			typeof candidate.customType === "string" &&
			options.stateTypes.has(candidate.customType)
		) {
			mode = options.decodeState(candidate.data)?.selectedMode ?? mode;
			continue;
		}
		if (candidate.type !== "message" || candidate.message?.role !== "user") continue;
		const displayText = options.displayText(extractUserMessageText(candidate.message.content));
		if (displayText) records.push({ text: displayText, mode });
	}
	return records;
}

function prependRail(line: string, rail: string): string {
	return line.replace(OSC133_PREFIX, `$1${rail}`);
}

export function installUserMessageRail(
	UserMessageComponent: UserMessageClass,
	options: {
		formatRail: (mode: Mode, glyph: string) => string;
		getFallbackMode: () => Mode;
	},
): UserMessageRailController {
	const globalState = globalThis as typeof globalThis & { [PATCH_KEY]?: RailPatchState };
	let state = globalState[PATCH_KEY];
	if (!state) {
		const originalRender = UserMessageComponent.prototype.render;
		state = {
			originalRender,
			componentModes: new WeakMap(),
			resolver: new TranscriptModeResolver(),
			formatRail: options.formatRail,
			getFallbackMode: options.getFallbackMode,
			glyph: "│",
		};
		globalState[PATCH_KEY] = state;
	}

	const owner = Symbol("pi-plan-build-user-message-rail-owner");
	state.owner = owner;
	state.formatRail = options.formatRail;
	state.getFallbackMode = options.getFallbackMode;
	state.glyph = "│";
	// Reinstall from the preserved original on every extension load. This migrates
	// already-running processes away from stale decorator code without stacking wrappers.
	UserMessageComponent.prototype.render = function renderWithModeRail(width: number): string[] {
		const active = globalState[PATCH_KEY];
		if (!active?.owner || width <= 1) return state.originalRender.call(this, width);
		let mode = active.componentModes.get(this);
		if (!mode) {
			const text = typeof this.text === "string" ? this.text : "";
			mode = active.resolver.resolve(text, active.getFallbackMode());
			active.componentModes.set(this, mode);
		}
		const rail = active.formatRail(mode, active.glyph);
		return active.originalRender.call(this, width - 1).map((line) => prependRail(line, rail));
	};

	return {
		activate() {
			const active = globalState[PATCH_KEY];
			if (active) active.owner = owner;
		},
		setTranscript(records) {
			const active = globalState[PATCH_KEY];
			if (active?.owner !== owner) return;
			active.componentModes = new WeakMap();
			active.resolver.setTranscript(records);
		},
		addMessage(text, mode) {
			const active = globalState[PATCH_KEY];
			if (active?.owner === owner) active.resolver.addMessage(text, mode);
		},
		deactivate() {
			const active = globalState[PATCH_KEY];
			if (active?.owner === owner) active.owner = undefined;
		},
	};
}
