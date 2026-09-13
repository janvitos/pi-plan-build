import type { Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, truncateToWidth, visibleWidth, VStack, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { PlanExecutionState } from "./plan-execution.ts";

/**
 * ScrollView whose wheel events never chain to the chat. pi-tui's routeWheel stops walking
 * the hit ScrollViews when overscroll is "contain", but its primary fallback still forwards
 * unconsumed wheel lines to the chat's ScrollView. Returning 0 from scrollBy marks every
 * wheel as fully consumed, so that fallback never fires.
 * ponytail: delete this class once pi-tui's routeWheel honors containment against the primary fallback.
 */
export class ContainedScrollView extends ScrollView {
	override scrollBy(lines: number): number {
		super.scrollBy(lines);
		return 0;
	}
}

const GLYPHS = {
	pending: "○",
	ready: "▷",
	active: "▶",
	completed: "✓",
	skipped: "–",
} as const;

function panelFrame(width: number, theme: Theme) {
	const safeWidth = Math.max(12, width);
	const inner = Math.max(1, safeWidth - 2);
	const contentWidth = Math.max(1, safeWidth - 4);
	const border = (text: string) => theme.fg("borderMuted", text);
	const pad = (content = "") => {
		const clipped = truncateToWidth(content, contentWidth, "");
		return `${border("│")} ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} ${border("│")}`;
	};
	const fit = (lines: string[]) => lines.map((line) => truncateToWidth(line, safeWidth, ""));
	return { safeWidth, inner, contentWidth, border, pad, fit };
}

class PlanPanelHeader implements Component {
	private state: PlanExecutionState;
	private readonly theme: Theme;

	constructor(state: PlanExecutionState, theme: Theme) {
		this.state = state;
		this.theme = theme;
	}

	setState(state: PlanExecutionState): void {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { inner, border, pad, fit } = panelFrame(width, this.theme);
		const done = this.state.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
		const status = this.state.status === "completed" ? "complete" : this.state.status;
		return fit([
			border(`╭${"─".repeat(inner)}╮`),
			pad(`${this.theme.bold(this.theme.fg("accent", "Plan"))} ${this.theme.fg("dim", `${done}/${this.state.steps.length}`)}`),
			pad(this.theme.fg(this.state.status === "completed" ? "success" : this.state.status === "paused" ? "warning" : "muted", status)),
			border(`├${"─".repeat(inner)}┤`),
		]);
	}
}

class PlanPanelSteps implements Component {
	private state: PlanExecutionState;
	private readonly theme: Theme;

	constructor(state: PlanExecutionState, theme: Theme) {
		this.state = state;
		this.theme = theme;
	}

	setState(state: PlanExecutionState): void {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { contentWidth, pad, fit } = panelFrame(width, this.theme);
		const lines: string[] = [];
		for (let index = 0; index < this.state.steps.length; index++) {
			const step = this.state.steps[index]!;
			const glyphColor = step.status === "completed" ? "success" : step.status === "active" || step.status === "ready" ? "accent" : "muted";
			const prefix = `${this.theme.fg(glyphColor, GLYPHS[step.status])} ${index + 1}. `;
			const text = step.status === "completed" || step.status === "skipped" ? this.theme.fg("muted", step.text) : step.text;
			const wrapped = wrapTextWithAnsi(text, Math.max(1, contentWidth - visibleWidth(prefix)));
			lines.push(pad(`${prefix}${wrapped[0] ?? ""}`));
			const continuationIndent = " ".repeat(visibleWidth(prefix));
			for (const continuation of wrapped.slice(1)) lines.push(pad(`${continuationIndent}${continuation}`));
			if (index < this.state.steps.length - 1) lines.push(pad());
		}
		return fit(lines);
	}
}

class PlanPanelGuidance implements Component {
	private readonly theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { inner, contentWidth, border, pad, fit } = panelFrame(width, this.theme);
		const lines = [border(`├${"─".repeat(inner)}┤`)];
		const bold = (text: string) => this.theme.bold(text);
		for (const entry of [
			bold("You can:"),
			`- ${bold("Proceed")} with the next step.`,
			`- ${bold("Revise")} or ${bold("skip")} a step.`,
			`- ${bold("Pause")} or ${bold("stop")} execution.`,
			`- ${bold("Complete")} the plan at any time.`,
		]) {
			for (const line of wrapTextWithAnsi(entry, contentWidth)) lines.push(pad(line));
		}
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return fit(lines);
	}
}

export class PlanPanel extends VStack {
	private readonly header: PlanPanelHeader;
	private readonly steps: PlanPanelSteps;

	constructor(state: PlanExecutionState, theme: Theme) {
		const header = new PlanPanelHeader(state, theme);
		const steps = new PlanPanelSteps(state, theme);
		const stepScroller = new ContainedScrollView(steps, { overscroll: "contain", scrollbar: "auto" });
		const guidance = new PlanPanelGuidance(theme);
		super([
			{ component: header, basis: "auto", grow: 0, shrink: 0 },
			{ component: stepScroller, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			{ component: guidance, basis: "auto", grow: 0, shrink: 0 },
		]);
		this.header = header;
		this.steps = steps;
	}

	setState(state: PlanExecutionState): void {
		this.header.setState(state);
		this.steps.setState(state);
	}
}
