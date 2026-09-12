import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { PlanExecutionState } from "./plan-execution.ts";

const GLYPHS = {
	pending: "○",
	ready: "▷",
	active: "▶",
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
		const lines = [
			border(`╭${"─".repeat(inner)}╮`),
			pad(`${this.theme.bold(this.theme.fg("accent", "Plan"))} ${this.theme.fg("dim", `${done}/${this.state.steps.length}`)}`),
			pad(this.theme.fg(this.state.status === "completed" ? "success" : this.state.status === "paused" ? "warning" : "muted", status)),
			border(`├${"─".repeat(inner)}┤`),
		];
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
		lines.push(border(`├${"─".repeat(inner)}┤`));
		const instructions = [
			this.theme.bold("How to use"),
			"",
			"Write your instructions in the chat.",
			"",
			"- Write “Proceed” to start the next step.",
			"- Ask to edit, skip, or mark a step complete.",
			"- Ask to pause, resume, or cancel execution.",
			"- Ask to hide or show this panel.",
			"",
			"You can use your own words.",
		];
		for (const instruction of instructions) {
			for (const line of wrapTextWithAnsi(instruction, contentWidth)) lines.push(pad(line));
		}
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}
}
