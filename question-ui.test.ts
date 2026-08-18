import assert from "node:assert/strict";
import test from "node:test";
import { registerQuestionTool } from "./question-ui.ts";

const prompt = (question: string, overrides: Record<string, unknown> = {}) => ({
	question,
	header: question.slice(0, 8),
	options: [{ label: "Yes" }, { label: "No" }],
	...overrides,
});

function getQuestionTool(): { tool: any; entries: any[] } {
	let tool: any;
	const entries: any[] = [];
	registerQuestionTool({
		registerEntryRenderer() {},
		registerTool(candidate: any) {
			tool = candidate;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	} as any);
	return { tool, entries };
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
		data: { message: "You chose not to answer the question(s). Awaiting your instructions." },
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
