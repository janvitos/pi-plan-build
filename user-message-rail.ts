import { extractUserMessageText, type Mode } from "./utils.ts";

const ANSI_SEQUENCE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/uy;
const SGR_SEQUENCE = /\x1b\[([0-9:;]*)m/gu;
const PATCH_KEY = Symbol.for("@janvitos/pi-plan-build:user-message-rail");
const USER_MESSAGE_RAIL_GLYPH = "│";

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

function firstVisibleIndex(line: string): number {
	let index = 0;
	while (line[index] === "\x1b") {
		ANSI_SEQUENCE.lastIndex = index;
		const match = ANSI_SEQUENCE.exec(line);
		if (!match) break;
		index += match[0].length;
	}
	return index;
}

function insertRailAndPadding(line: string, rail: string): string | undefined {
	const index = firstVisibleIndex(line);
	if (line[index] !== " ") return undefined;
	const prefix = line.slice(0, index);
	const background = [...prefix.matchAll(SGR_SEQUENCE)]
		.filter((match) => /(?:^|;)(?:4[0-8]|10[0-7]|48(?=[:;]|$))/u.test(match[1]!))
		.at(-1)?.[0];
	if (!background) return undefined;
	return `${prefix}\x1b[49m${rail}${background} ${line.slice(index + 1)}`;
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
			glyph: USER_MESSAGE_RAIL_GLYPH,
		};
		globalState[PATCH_KEY] = state;
	}

	const owner = Symbol("pi-plan-build-user-message-rail-owner");
	state.owner = owner;
	state.formatRail = options.formatRail;
	state.getFallbackMode = options.getFallbackMode;
	state.glyph = USER_MESSAGE_RAIL_GLYPH;
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
		const insetLines = active.originalRender.call(this, width - 1);
		const decoratedLines = insetLines.map((line) => insertRailAndPadding(line, rail));
		if (decoratedLines.every((line): line is string => line !== undefined)) return decoratedLines;
		return active.originalRender.call(this, width);
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
