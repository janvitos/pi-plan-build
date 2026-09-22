const FILTER_RECORD = Symbol.for("@janvitos/pi-plan-build/thinking-status-filter");
const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const THINKING_STATUS = /^Thinking level: .+$/;

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
	owner: object;
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

function isThinkingStatus(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as ComponentShape;
	if (typeof candidate.text !== "string" || candidate.paddingX !== 1 || candidate.paddingY !== 0) return false;
	return THINKING_STATUS.test(candidate.text.replace(ANSI_ESCAPE, "").trim());
}

function isStatusSpacer(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as ComponentShape;
	return candidate.lines === 1 && value.constructor?.name === "Spacer";
}

/** Remove Pi's exact spacer/text pair for the redundant thinking-level chat status. */
export function removeThinkingLevelStatuses(root: unknown): number {
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
			if (isThinkingStatus(child) && index > 0 && isStatusSpacer(component(children[index - 1]))) {
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

/** Filter redundant thinking statuses immediately before this composer's TUI renders. */
export function installThinkingStatusFilter(surface: FilterSurface): () => void {
	const owner = {};
	const existing = surface[FILTER_RECORD];
	if (existing && surface.requestRender === existing.wrapper) {
		existing.owner = owner;
		return () => {
			if (existing.owner !== owner || surface.requestRender !== existing.wrapper) return;
			surface.requestRender = existing.original;
			delete surface[FILTER_RECORD];
		};
	}

	if (existing) delete surface[FILTER_RECORD];
	const original = surface.requestRender;
	const wrapper: RenderFunction = function (this: FilterSurface, ...args: Parameters<RenderFunction>) {
		removeThinkingLevelStatuses(surface.layoutRoot ?? surface);
		return Reflect.apply(original, this, args);
	};
	const record: FilterRecord = { original, wrapper, owner };
	Object.defineProperty(surface, FILTER_RECORD, { value: record, configurable: true, writable: true });
	surface.requestRender = wrapper;

	return () => {
		if (record.owner !== owner || surface.requestRender !== wrapper) return;
		surface.requestRender = original;
		delete surface[FILTER_RECORD];
	};
}
