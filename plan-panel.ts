import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { PlanExecutionState } from "./plan-execution.ts";

const GLYPHS = {
	pending: "○",
	ready: "▷",
	active: "▶",
	review: "◆",
	completed: "✓",
	skipped: "–",
} as const;

export class PlanPanel implements Component {
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
		const safeWidth = Math.max(12, width);
		const inner = Math.max(1, safeWidth - 2);
		const contentWidth = Math.max(1, safeWidth - 4);
		const border = (text: string) => this.theme.fg("borderMuted", text);
		const pad = (content = "") => {
			const clipped = truncateToWidth(content, contentWidth, "");
			return `${border("│")} ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} ${border("│")}`;
		};
		const done = this.state.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
		const status = this.state.status === "completed" ? "complete" : this.state.status;
		const currentIndex = this.state.steps.findIndex((step) => step.id === this.state.selectedStepId);
		const lines = [
			border(`╭${"─".repeat(inner)}╮`),
			pad(`${this.theme.bold(this.theme.fg("accent", "Plan"))} ${this.theme.fg("dim", `${done}/${this.state.steps.length}`)}`),
			pad(this.theme.fg(this.state.status === "paused" ? "warning" : "muted", status)),
			border(`├${"─".repeat(inner)}┤`),
		];
		for (let index = 0; index < this.state.steps.length; index++) {
			const step = this.state.steps[index]!;
			const glyphColor = step.status === "completed" ? "success" : step.status === "review" ? "warning" : step.status === "active" || step.status === "ready" ? "accent" : "muted";
			const prefix = `${this.theme.fg(glyphColor, GLYPHS[step.status])} ${index + 1}. `;
			const text = step.status === "completed" || step.status === "skipped" ? this.theme.fg("muted", step.text) : step.text;
			const wrapped = wrapTextWithAnsi(text, Math.max(1, contentWidth - visibleWidth(prefix)));
			lines.push(pad(`${prefix}${wrapped[0] ?? ""}`));
			const continuationIndent = " ".repeat(visibleWidth(prefix));
			for (const continuation of wrapped.slice(1)) lines.push(pad(`${continuationIndent}${continuation}`));
			if (index < this.state.steps.length - 1) lines.push(pad());
		}
		const current = currentIndex >= 0 ? this.state.steps[currentIndex] : undefined;
		if (current) {
			lines.push(border(`├${"─".repeat(inner)}┤`));
			for (const detail of wrapTextWithAnsi(current.text, contentWidth).slice(0, 5)) lines.push(pad(detail));
			if (current.summary) {
				lines.push(pad(this.theme.fg("dim", "Result:")));
				for (const summary of wrapTextWithAnsi(current.summary, contentWidth).slice(0, 4)) lines.push(pad(summary));
			}
		}
		lines.push(border(`├${"─".repeat(inner)}┤`));
		if (this.state.status === "completed") lines.push(pad(this.theme.fg("success", "Plan complete")));
		else if (this.state.status === "paused") lines.push(pad("Tell the agent to resume, cancel, or hide the plan."));
		else if (current?.status === "ready") lines.push(pad("Tell the agent to implement, complete, edit, skip, cancel, or hide this step."));
		else if (current?.status === "review") lines.push(pad("Tell the agent to accept, correct, or cancel the plan."));
		else lines.push(pad("Plan progress updates automatically from your prompts."));
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}
}
