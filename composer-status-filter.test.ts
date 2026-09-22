import assert from "node:assert/strict";
import test from "node:test";
import { Spacer } from "@earendil-works/pi-tui";
import { installComposerStatusFilter, removeRedundantComposerStatuses } from "./composer-status-filter.ts";

function text(value: string, paddingX = 1, paddingY = 0) {
	return { text: value, paddingX, paddingY };
}

test("removes exact ANSI-styled thinking and model status pairs throughout the component tree", () => {
	const nested = {
		children: [
			new Spacer(1), text("\x1b[2mThinking level: high\x1b[22m"),
			new Spacer(1), text("\x1b[2mModel: claude-sonnet-4-5\x1b[22m"),
		],
	};
	const root: any = { children: [{ component: nested }] };
	root.children.push(root);

	assert.equal(removeRedundantComposerStatuses(root), 2);
	assert.deepEqual(nested.children, []);
});

test("preserves distinct model feedback, unrelated statuses, and malformed lookalikes", () => {
	const values = [
		"Switched to Claude Sonnet (thinking: high)",
		"Default model: anthropic/claude-sonnet-4-5",
		"Refreshing model catalogs…",
		"Only one model available",
		"Model selection failed",
	];
	const children = values.flatMap((value) => [new Spacer(1), text(value)]);
	children.push(text("Model: unpaired"), text("Model: wrong-padding", 0, 0));
	const root = { children };

	assert.equal(removeRedundantComposerStatuses(root), 0);
	assert.equal(root.children.length, values.length * 2 + 2);
});

test("filters before rendering while preserving receiver and arguments", () => {
	const children = [new Spacer(1), text("Model: gpt-5")];
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

	const dispose = installComposerStatusFilter(surface);
	surface.requestRender(true);
	assert.equal(receivedThis, surface);
	assert.equal(receivedForce, true);
	dispose();
});

test("repeated installation replaces rather than stacks the wrapper and only the latest owner restores", () => {
	let renders = 0;
	const original = function (this: unknown) { renders++; };
	const surface: any = { children: [], requestRender: original };
	const disposeFirst = installComposerStatusFilter(surface);
	const firstWrapper = surface.requestRender;
	const disposeSecond = installComposerStatusFilter(surface);

	assert.notEqual(surface.requestRender, firstWrapper, "a reload installs the current filter implementation");
	disposeFirst();
	assert.notEqual(surface.requestRender, original, "a superseded disposer cannot remove the current filter");
	surface.requestRender();
	assert.equal(renders, 1, "one wrapper delegates exactly once to the preserved original");
	disposeSecond();
	assert.equal(surface.requestRender, original);
});
