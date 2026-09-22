// Keep the original symbol identity so /reload can replace an older thinking-only wrapper.
const FILTER_RECORD = Symbol.for("@janvitos/pi-plan-build/thinking-status-filter");
const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const REDUNDANT_STATUS = /^(?:Thinking level|Model): .+$/;

type RenderFunction = (force?: boolean) => void;

type FilterSurface = {
	requestRender: RenderFunction;
	layoutRoot?: unknown;
	children?: unknown[];
	[FILTER_RECORD]?: FilterRecord;
};

type FilterRecord = {
	original: RenderFunction;
	wrapper: RenderFunction;
};

type ComponentShape = {
	children?: unknown[];
	component?: unknown;
	text?: unknown;
	paddingX?: unknown;
	paddingY?: unknown;
	lines?: unknown;
};

function component(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	return (value as ComponentShape).component ?? value;
}

function isRedundantStatus(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as ComponentShape;
	if (typeof candidate.text !== "string" || candidate.paddingX !== 1 || candidate.paddingY !== 0) return false;
	return REDUNDANT_STATUS.test(candidate.text.replace(ANSI_ESCAPE, "").trim());
}

function isStatusSpacer(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as ComponentShape;
	return candidate.lines === 1 && value.constructor?.name === "Spacer";
}

/** Remove exact spacer/text pairs for statuses already represented by the composer. */
export function removeRedundantComposerStatuses(root: unknown): number {
	const seen = new Set<object>();
	let removed = 0;

	function visit(value: unknown): void {
		const node = component(value);
		if (!node || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		const children = (node as ComponentShape).children;
		if (!Array.isArray(children)) return;

		for (let index = children.length - 1; index >= 0; index--) {
			const child = component(children[index]);
			if (isRedundantStatus(child) && index > 0 && isStatusSpacer(component(children[index - 1]))) {
				children.splice(index - 1, 2);
				removed++;
				index--;
				continue;
			}
			visit(child);
		}
	}

	visit(root);
	return removed;
}

/** Filter redundant statuses immediately before this composer's TUI renders. */
export function installComposerStatusFilter(surface: FilterSurface): () => void {
	const existing = surface[FILTER_RECORD];
	if (existing && surface.requestRender === existing.wrapper) {
		// Reinstall from the preserved original so a live /reload adopts new matching logic.
		surface.requestRender = existing.original;
	}
	if (existing) delete surface[FILTER_RECORD];

	const original = surface.requestRender;
	const wrapper: RenderFunction = function (this: FilterSurface, ...args: Parameters<RenderFunction>) {
		removeRedundantComposerStatuses(surface.layoutRoot ?? surface);
		return Reflect.apply(original, this, args);
	};
	const record: FilterRecord = { original, wrapper };
	Object.defineProperty(surface, FILTER_RECORD, { value: record, configurable: true, writable: true });
	surface.requestRender = wrapper;

	return () => {
		if (surface.requestRender !== wrapper) return;
		surface.requestRender = original;
		delete surface[FILTER_RECORD];
	};
}
