import assert from "node:assert/strict";
import test from "node:test";
import {
	collectTranscriptModeRecords,
	installUserMessageRail,
	TranscriptModeResolver,
} from "./user-message-rail.ts";
import { extractPromptHistory, type Mode } from "./utils.ts";

const OSC_START = "\x1b]133;A\x07";
const OSC_END = "\x1b]133;B\x07\x1b]133;C\x07";
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
const OSC_PATTERN = /\x1b\][^\x07]*\x07/gu;

class FakeUserMessageComponent {
	text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		const fill = (text: string) => text + " ".repeat(Math.max(0, width - text.length));
		return [`${OSC_START}${fill("")}`, fill(this.text), `${OSC_END}${fill("")}`];
	}
}

function visible(text: string): string {
	return text.replace(ANSI_PATTERN, "").replace(OSC_PATTERN, "");
}

function formatter(mode: Mode, glyph: string): string {
	const color = mode === "plan" ? "245;167;66" : "92;156;245";
	return `\x1b[38;2;${color}m${glyph}\x1b[0m`;
}

test("shared text extraction preserves transcript whitespace but normalizes history", () => {
	const content = [null, { type: "image", data: "ignored" }, { type: "text", text: "  Same " }, { type: "text", text: 42 }, { type: "text", text: "prompt  " }];
	const entries = [
		{ type: "message", message: { role: "user", content } },
		{ type: "message", message: { role: "user", content: "Same prompt" } },
	];
	const records = collectTranscriptModeRecords(entries, { stateTypes: new Set(), decodeState: () => undefined, displayText: text => text });
	assert.deepEqual(records.map(record => record.text), ["  Same prompt  ", "Same prompt"]);
	assert.deepEqual(extractPromptHistory(entries), ["Same prompt"]);
});

test("transcript records retain the mode persisted before each user message", () => {
	const stateTypes = new Set(["pi-plan-build-state", "opencode-modes-state"]);
	const entries = [
		{ type: "custom", customType: "pi-plan-build-state", data: { version: 1, selectedMode: "build" } },
		{ type: "message", message: { role: "user", content: "same prompt" } },
		{ type: "custom", customType: "pi-plan-build-state", data: { version: 1, selectedMode: "plan" } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "same " }, { type: "text", text: "prompt" }] } },
	];
	assert.deepEqual(
		collectTranscriptModeRecords(entries, {
			stateTypes,
			decodeState: (data) => data as { selectedMode: Mode },
			displayText: (text) => text,
		}),
		[
			{ text: "same prompt", mode: "build" },
			{ text: "same prompt", mode: "plan" },
		],
	);
});

test("resolver preserves repeated-prompt order across component-tree rebuilds", () => {
	const resolver = new TranscriptModeResolver();
	resolver.setTranscript([
		{ text: "same", mode: "build" },
		{ text: "same", mode: "plan" },
	]);
	assert.equal(resolver.resolve("same", "plan"), "build");
	assert.equal(resolver.resolve("same", "build"), "plan");
	assert.equal(resolver.resolve("same", "plan"), "build");
	assert.equal(resolver.resolve("same", "build"), "plan");
});

test("thin rails cover every row, preserve width and OSC prefixes, and keep submitted colors", () => {
	let fallback: Mode = "build";
	const controller = installUserMessageRail(FakeUserMessageComponent, {
		formatRail: formatter,
		getFallbackMode: () => fallback,
	});
	controller.setTranscript([
		{ text: "build prompt", mode: "build" },
		{ text: "plan prompt", mode: "plan" },
	]);

	const build = new FakeUserMessageComponent("build prompt");
	const plan = new FakeUserMessageComponent("plan prompt");
	const buildLines = build.render(24);
	const planLines = plan.render(24);
	for (const line of [...buildLines, ...planLines]) assert.equal(visible(line).length, 24);
	assert.equal(buildLines.map((line) => visible(line)[0]).join(""), "│││");
	assert.equal(planLines.map((line) => visible(line)[0]).join(""), "│││");
	assert.ok(buildLines.every((line) => line.includes("\x1b[38;2;92;156;245m")));
	assert.ok(planLines.every((line) => line.includes("\x1b[38;2;245;167;66m")));
	assert.ok(buildLines[0]!.startsWith(OSC_START));
	assert.ok(buildLines.at(-1)!.startsWith(OSC_END));

	fallback = "plan";
	assert.equal(build.render(24).map((line) => visible(line)[0]).join(""), "│││");
	controller.deactivate();
});

test("installing repeatedly does not stack rails and only the latest owner can deactivate", () => {
	const first = installUserMessageRail(FakeUserMessageComponent, {
		formatRail: formatter,
		getFallbackMode: () => "build",
	});
	const second = installUserMessageRail(FakeUserMessageComponent, {
		formatRail: formatter,
		getFallbackMode: () => "plan",
	});
	second.setTranscript([{ text: "message", mode: "plan" }]);
	first.deactivate();
	const activeLines = new FakeUserMessageComponent("message").render(20);
	assert.equal(activeLines.map((line) => visible(line)[0]).join(""), "│││");
	second.deactivate();
	assert.ok(new FakeUserMessageComponent("message").render(20).every((line) => !visible(line).includes("│")));
	second.activate();
	second.setTranscript([{ text: "restored", mode: "build" }]);
	const restoredLines = new FakeUserMessageComponent("restored").render(20);
	assert.equal(restoredLines.map((line) => visible(line)[0]).join(""), "│││");
	second.deactivate();
});
