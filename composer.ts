import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HStack, matchesKey, truncateToWidth, visibleWidth, isViewportTUI, type Component, type TUI, type ViewportTUI } from "@earendil-works/pi-tui";
import { PlanPanel } from "./plan-panel.ts";
import type { PlanExecutionState } from "./plan-execution.ts";
import { formatModeRail, formatModeMetadata, formatModeTopBorder, nextMode, ownsUiSlot, renderModeComposer, shouldReduceOptionalUi, type Mode } from "./utils.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
const STATUS_KEY = "pi-plan-build-mode";
export const PANEL_MIN_TERMINAL_WIDTH = 132;
const PANEL_WIDTH = 64;

/** Owns optional UI only. Lifecycle and durable progress belong to PlanState. */
export function createComposer(
	pi: ExtensionAPI,
	shortcuts: { toggleMode: string[]; toggleModeInEditor: string[]; showPlanTitle?: boolean },
	view: () => { mode: Mode; title?: string; execution?: PlanExecutionState },
	selectMode: (mode: Mode, ctx: ExtensionContext) => void,
) {
	let ctx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let panel: PlanPanel | undefined;
	let tui: (TUI & Partial<ViewportTUI>) | undefined;
	let originalRoot: Component | undefined;
	let panelRoot: Component | undefined;
	let token: { enabled: boolean } | undefined;
	let installed: EditorFactory | undefined;
	let mounting: EditorFactory | undefined;
	let capable = false;
	let reduced = false;
	let noticeShown = false;
	const root = () => (tui as (TUI & { layoutRoot?: Component }) | undefined)?.layoutRoot;

	function removePanel() {
		if (token) token.enabled = false;
		if (!panelRoot) { panel = undefined; token = undefined; return; }
		if (tui && originalRoot && ownsUiSlot(root(), panelRoot)) {
			tui.setLayoutRoot?.(originalRoot);
			panelRoot = undefined;
			panel = undefined;
			token = undefined;
		}
		tui?.requestRender();
	}
	function status() {
		if (!ctx) return;
		const { mode, title } = view();
		ctx.ui.setStatus(STATUS_KEY, shortcuts.showPlanTitle && title ? ctx.ui.theme.fg("warning", title) : formatModeRail(mode, ctx.ui.theme, ctx.ui.theme.bold(mode)));
	}
	function conflict(context = ctx): boolean {
		if (!context) return false;
		ctx = context;
		if (reduced) return true;
		const expected = panelRoot ?? originalRoot;
		if (shouldReduceOptionalUi(ctx.ui.getEditorComponent(), mounting ?? installed) || expected !== undefined && !ownsUiSlot(root(), expected)) {
			reduced = true;
			removePanel();
			capable = false;
			status();
			if (!noticeShown) {
				noticeShown = true;
				ctx.ui.notify(`Another extension owns Pi's custom editor or fullscreen layout. Pi Plan Build disabled its custom composer and experimental step-by-step panel; Plan and Build workflows remain available through ${shortcuts.toggleMode.length ? `${shortcuts.toggleMode.join(", ")}, ` : ""}/plan, and /build.`, "warning");
			}
		}
		return reduced;
	}
	function ensurePanel(): boolean {
		const { execution } = view();
		if (!execution || !capable || !tui || !originalRoot || !ctx || conflict()) return false;
		if (!panel) panel = new PlanPanel(execution, ctx.ui.theme);
		else panel.setState(execution);
		if (!panelRoot) {
			const layoutToken = { enabled: true };
			token = layoutToken;
			panelRoot = new HStack([
				{ component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 58 },
				{ component: panel, basis: PANEL_WIDTH, grow: 0, shrink: 0, minSize: PANEL_WIDTH, maxSize: PANEL_WIDTH,
					visible: (viewport) => layoutToken.enabled && !reduced && !!view().execution && view().execution?.panelVisible !== false && viewport.width >= PANEL_MIN_TERMINAL_WIDTH },
			]);
			tui.setLayoutRoot?.(panelRoot);
		}
		tui.requestRender();
		return true;
	}
	function update(context: ExtensionContext) {
		ctx = context;
		if (conflict()) { status(); return; }
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (view().execution) panel?.setState(view().execution!);
		requestRender?.();
	}
	function mount(context: ExtensionContext, history: string[]) {
		ctx = context;
		installed = undefined;
		mounting = undefined;
		reduced = false;
		noticeShown = false;
		if (conflict() || ctx.mode !== "tui") return;
		class ModeEditor extends CustomEditor {
			override render(width: number): string[] {
				if (reduced) return super.render(width);
				const railWidth = 2;
				const paddingWidth = Math.min(railWidth, Math.max(0, Math.floor((width - 1) / 2)));
				if (this.getPaddingX() !== railWidth) this.setPaddingX(railWidth);
				const lines = super.render(width);
				if (paddingWidth !== railWidth || !ctx) return lines;
				const { mode, title } = view();
				const metadata = formatModeMetadata(mode, pi.getThinkingLevel(), ctx.ui.theme, this.borderColor, { modelName: ctx.model?.id ?? "no-model", modelProvider: ctx.model?.provider, rail: "" });
				return renderModeComposer(lines, formatModeTopBorder(mode, width, this.borderColor("╮"), ctx.ui.theme, shortcuts.showPlanTitle ? title : undefined), `${formatModeRail(mode, ctx.ui.theme)} `, this.borderColor("│"), metadata, formatModeRail(mode, ctx.ui.theme, "╰"), railWidth, width, { truncate: (line, max) => truncateToWidth(line, max, ""), measure: visibleWidth }, (text) => this.borderColor(text));
			}
			override handleInput(data: string): void {
				if (!reduced && !this.isShowingAutocomplete() && shortcuts.toggleModeInEditor.some((shortcut) => matchesKey(data, shortcut as Parameters<typeof matchesKey>[1]))) {
					if (ctx) selectMode(nextMode(view().mode), ctx);
					return;
				}
				super.handleInput(data);
			}
		}
		installed = (surface, theme, keybindings) => {
			mounting = context.ui.getEditorComponent() ?? installed;
			const editor = new ModeEditor(surface, theme, keybindings);
			for (const prompt of history) editor.addToHistory(prompt);
			requestRender = () => surface.requestRender();
			tui = surface;
			capable = isViewportTUI(surface) && typeof (surface as ViewportTUI).setLayoutRoot === "function";
			if (capable && !originalRoot) {
				originalRoot = (surface as TUI & { layoutRoot?: Component }).layoutRoot;
				capable = originalRoot !== undefined;
			}
			if (view().execution?.status !== "completed") ensurePanel();
			return editor;
		};
		ctx.ui.setEditorComponent(installed);
		if (view().execution && !capable) ctx.ui.notify("Step-by-step progress was restored, but its plan panel requires fullscreen TUI mode. Progress is preserved.", "warning");
	}
	function dispose(context: ExtensionContext) {
		removePanel();
		context.ui.setStatus(STATUS_KEY, undefined);
		if (ownsUiSlot(context.ui.getEditorComponent(), installed)) context.ui.setEditorComponent(undefined);
		requestRender = undefined;
		installed = mounting = undefined;
		panel = undefined;
		tui = undefined;
		panelRoot = originalRoot = undefined;
		token = undefined;
		capable = reduced = noticeShown = false;
		ctx = undefined;
	}
	return { mount, update, conflict, ensurePanel, removePanel, dispose,
		get reduced() { return reduced; }, get capable() { return capable; },
		get panelAvailable() { return !reduced && capable && (tui?.terminal.columns ?? 0) >= PANEL_MIN_TERMINAL_WIDTH; } };
}
