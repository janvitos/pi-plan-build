import assert from "node:assert/strict";
import test from "node:test";
import { Spacer } from "@earendil-works/pi-tui";
import { installThinkingStatusFilter, removeThinkingLevelStatuses } from "./thinking-status-filter.ts";

function text(value: string, paddingX = 1, paddingY = 0) {
	return { text: value, paddingX, paddingY };
}

test("removes only ANSI-styled thinking status pairs throughout the component tree", () => {
	const thinkingSpacer = new Spacer(1);
	const nested = { children: [thinkingSpacer, text("\x1b[2mThinking level: high\x1b[22m")] };
	const root: any = { children: [{ component: nested }] };
	root.children.push(root);

	assert.equal(removeThinkingLevelStatuses(root), 1);
	assert.deepEqual(nested.children, []);
});

test("preserves unrelated statuses and lookalikes without Pi's status shape", () => {
	const unrelatedSpacer = new Spacer(1);
	const unrelated = text("Model switched");
	const missingSpacer = text("Thinking level: low");
	const wrongPadding = text("Thinking level: medium", 0, 0);
	const root = { children: [unrelatedSpacer, unrelated, missingSpacer, wrongPadding] };

	assert.equal(removeThinkingLevelStatuses(root), 0);
	assert.deepEqual(root.children, [unrelatedSpacer, unrelated, missingSpacer, wrongPadding]);
});

test("filters before rendering while preserving receiver and arguments", () => {
	const children = [new Spacer(1), text("Thinking level: xhigh")];
	let receivedThis: unknown;
	let receivedForce: boolean | undefined;
	const surface: any = {
		layoutRoot: { children },
		requestRender(force?: boolean) {
			receivedThis = this;
			receivedForce = force;
			assert.deepEqual(children, []);
		},
	};

	const dispose = installThinkingStatusFilter(surface);
	surface.requestRender(true);
	assert.equal(receivedThis, surface);
	assert.equal(receivedForce, true);
	dispose();
});

test("repeated installation does not stack and only the current owner restores", () => {
	let renders = 0;
	const original = function (this: unknown) { renders++; };
	const surface: any = { children: [], requestRender: original };
	const disposeFirst = installThinkingStatusFilter(surface);
	const wrapper = surface.requestRender;
	const disposeSecond = installThinkingStatusFilter(surface);

	assert.equal(surface.requestRender, wrapper);
	disposeFirst();
	assert.equal(surface.requestRender, wrapper, "a superseded owner cannot remove the active filter");
	surface.requestRender();
	assert.equal(renders, 1, "one wrapper delegates exactly once");
	disposeSecond();
	assert.equal(surface.requestRender, original);
});
