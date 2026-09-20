import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { QuestionParameters, registerQuestionTool } from "./question-ui.ts";

const prompt = (question: string, overrides: Record<string, unknown> = {}) => ({
	question,
	header: question.slice(0, 8),
	options: [{ label: "Yes" }, { label: "No" }],
	...overrides,
});

function getQuestionTool(): { tool: any; entries: any[]; entryRenderers: Map<string, any> } {
	let tool: any;
	const entries: any[] = [];
	const entryRenderers = new Map<string, any>();
	registerQuestionTool({
		on() {},
		registerEntryRenderer(type: string, renderer: any) { entryRenderers.set(type, renderer); },
		registerTool(candidate: any) {
			tool = candidate;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	} as any);
	return { tool, entries, entryRenderers };
}

function makeContext(select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>, input?: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>) {
	let abortCount = 0;
	return {
		context: {
			hasUI: true,
			abort() {
				abortCount++;
			},
			ui: {
				select,
				input: input ?? (async () => undefined),
			},
		},
		get abortCount() {
			return abortCount;
		},
	};
}

test("question header length is advisory while its type remains enforced", () => {
	const params = { questions: [prompt("Continue?", { header: "Current sword behavior" })] };
	assert.equal(Check(QuestionParameters, params), true);
	assert.equal(Check(QuestionParameters, {
		questions: [prompt("Continue?", { header: 42 })],
	}), false);
});

test("question output preserves answers without coaching and distinguishes rendering states", async () => {
	const { tool } = getQuestionTool();
	const { context } = makeContext(async () => "Yes");
	const result = await tool.execute("answer", { questions: [prompt("Continue?")] }, undefined, undefined, context);
	assert.match(result.content[0].text, /^Answers:/);
	assert.doesNotMatch(result.content[0].text, /You can now continue/);
	const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
	for (const expanded of [false, true]) {
		const render = (r: any, isPartial = false, isError = false) => tool.renderResult(r, { expanded, isPartial }, theme, { isError }).render(100).join("\n").trimEnd();
		const answer = render(result);
		const error = render({ content: [{ type: "text", text: "Connection failed" }] }, false, true);
		const multilineError = render({ content: [{ type: "text", text: "Connection failed" }, { type: "text", text: "Retry later" }] }, true, true);
		const unavailable = render({ content: [], details: {} });
		const cancelled = render({ content: [], details: { cancelled: true } });
		for (const rendered of [answer, error, multilineError, unavailable, cancelled]) assert.match(rendered, /^ \S/u);
		assert.match(answer, /Yes/);
		assert.match(error, /Connection failed/);
		assert.match(multilineError, /Connection failed[\s\S]*Retry later/);
		assert.equal(unavailable, " Answer status unavailable");
		assert.equal(render(result, true), "");
		const pending = tool.renderCall({}, theme, { isPartial: true }).render(100).join("\n").trimEnd();
		assert.match(pending, /^ Awaiting answers/u);
		assert.deepEqual(tool.renderCall({}, theme, { isPartial: false }).render(100), []);
		assert.equal(cancelled, " Question(s) skipped");
	}
	const skippedColors: Array<{ color: string; text: string }> = [];
	const capture = { fg: (color: string, text: string) => { skippedColors.push({ color, text }); return text; }, bold: (text: string) => text };
	tool.renderResult({ content: [], details: { cancelled: true } }, { expanded: false, isPartial: false }, capture, {}).render(100);
	assert.ok(skippedColors.some((call) => call.color === "muted" && call.text === "Question(s) skipped"));
});

test("question cancellation notices use the normal transcript inset", () => {
	const { entryRenderers } = getQuestionTool();
	const renderer = entryRenderers.get("pi-plan-build-question-notice");
	const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
	const rendered = renderer({ data: { message: "Cancelled" } }, { expanded: false }, theme).render(40).join("\n").trimEnd();
	assert.equal(rendered, " Cancelled");
});

test("cancelling a selector terminates cleanly and reports a skipped question", async () => {
	let receivedSignal: AbortSignal | undefined;
	const controller = new AbortController();
	const harness = makeContext(async (_title, _options, opts) => {
		receivedSignal = opts?.signal;
		return undefined;
	});
	const questionTool = getQuestionTool();

	const result = await questionTool.tool.execute(
		"call-1",
		{ questions: [prompt("Continue?")] },
		controller.signal,
		undefined,
		harness.context,
	);

	assert.equal(receivedSignal, controller.signal);
	assert.equal(harness.abortCount, 0);
	assert.deepEqual(questionTool.entries, [{
		type: "pi-plan-build-question-notice",
		data: { message: "You chose not to answer the question(s). Awaiting your instructions.", toolCallId: "call-1" },
	}]);
	assert.deepEqual(result.details, { cancelled: true });
	assert.equal(result.terminate, true);
	assert.equal(result.content[0].text, "You chose not to answer the question(s). Awaiting your instructions.");
});

test("cancelling custom input terminates without returning partial answers", async () => {
	const harness = makeContext(async () => "Type your own answer", async () => undefined);
	const questionTool = getQuestionTool();

	const result = await questionTool.tool.execute(
		"call-2",
		{ questions: [prompt("Name?")] },
		undefined,
		undefined,
		harness.context,
	);

	assert.equal(harness.abortCount, 0);
	assert.deepEqual(result.details, { cancelled: true });
	assert.equal(result.terminate, true);
});

test("cancelling one question stops a multi-question flow", async () => {
	const titles: string[] = [];
	let selectCount = 0;
	const harness = makeContext(async (title) => {
		titles.push(title);
		selectCount++;
		return selectCount === 1 ? "Yes" : undefined;
	});
	const questionTool = getQuestionTool();

	const result = await questionTool.tool.execute(
		"call-3",
		{ questions: [prompt("First?"), prompt("Second?"), prompt("Third?")] },
		undefined,
		undefined,
		harness.context,
	);

	assert.deepEqual(titles, ["First?: First?", "Second?: Second?"]);
	assert.equal(harness.abortCount, 0);
	assert.deepEqual(result.details, { cancelled: true });
	assert.equal(result.terminate, true);
});
