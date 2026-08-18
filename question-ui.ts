import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatQuestionAnswers, type QuestionAnswerData } from "./utils.ts";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Explanation shown with the option" })),
});

const PromptSchema = Type.Object({
	question: Type.String({ description: "The question to ask" }),
	header: Type.String({ description: "Short header (12 characters or fewer)", maxLength: 12 }),
	options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4 }),
	multiple: Type.Optional(Type.Boolean({ description: "Allow more than one selection" })),
	custom: Type.Optional(Type.Boolean({ description: "Allow a custom answer; defaults to true" })),
});

export const QuestionParameters = Type.Object({
	questions: Type.Array(PromptSchema, { minItems: 1, description: "Questions to ask the user" }),
});

export type QuestionAnswer = QuestionAnswerData;

const QUESTION_NOTICE_ENTRY_TYPE = "pi-plan-build-question-notice";
const QUESTION_CANCELLED_MESSAGE = "You chose not to answer the question(s). Awaiting your instructions.";

class QuestionCancelledError extends Error {
	constructor() {
		super("User cancelled the question");
		this.name = "QuestionCancelledError";
	}
}

async function askOne(
	ctx: any,
	prompt: {
		question: string;
		header: string;
		options: Array<{ label: string; description?: string }>;
		multiple?: boolean;
		custom?: boolean;
	},
	signal: AbortSignal | undefined,
): Promise<QuestionAnswer> {
	const allowCustom = prompt.custom !== false;
	const labels = prompt.options.map((option) =>
		option.description ? `${option.label} — ${option.description}` : option.label,
	);
	const selected: string[] = [];
	let usedCustom = false;

	if (!prompt.multiple) {
		const choices = [...labels, ...(allowCustom ? ["Type your own answer"] : [])];
		const choice = await ctx.ui.select(`${prompt.header}: ${prompt.question}`, choices, { signal });
		if (!choice) throw new QuestionCancelledError();
		if (allowCustom && choice === "Type your own answer") {
			const custom = await ctx.ui.input(prompt.header, prompt.question, { signal });
			if (!custom?.trim()) throw new QuestionCancelledError();
			selected.push(custom.trim());
			usedCustom = true;
		} else {
			selected.push(prompt.options[labels.indexOf(choice)]?.label ?? choice);
		}
	} else {
		const remaining = prompt.options.map((option) => option.label);
		while (true) {
			const choices = [
				...remaining.map((label) => `Add: ${label}`),
				...(allowCustom ? ["Add a custom answer"] : []),
				...(selected.length ? [`Done (${selected.join(", ")})`] : []),
			];
			const choice = await ctx.ui.select(`${prompt.header}: ${prompt.question}`, choices, { signal });
			if (!choice) throw new QuestionCancelledError();
			if (choice.startsWith("Done (")) break;
			if (choice === "Add a custom answer") {
				const custom = await ctx.ui.input(prompt.header, prompt.question, { signal });
				if (custom?.trim()) {
					selected.push(custom.trim());
					usedCustom = true;
				}
				continue;
			}
			const label = choice.slice("Add: ".length);
			selected.push(label);
			remaining.splice(remaining.indexOf(label), 1);
			if (remaining.length === 0 && !allowCustom) break;
		}
	}

	return { question: prompt.question, header: prompt.header, answers: selected, custom: usedCustom };
}

export function registerQuestionTool(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<{ message: string }>(QUESTION_NOTICE_ENTRY_TYPE, (entry, _options, theme) => {
		const message = typeof entry.data?.message === "string" ? entry.data.message : QUESTION_CANCELLED_MESSAGE;
		return new Text(theme.fg("warning", message), 0, 0);
	});
	pi.registerTool({
		name: "question",
		label: "Question",
		description: `Use this tool when you need to ask the user questions during execution. This allows you to gather preferences, clarify ambiguous instructions, get implementation decisions, or offer choices. When custom is enabled (default), do not add an Other option yourself. Put the recommended option first and suffix its label with "(Recommended)".`,
		parameters: QuestionParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("The question tool requires an interactive TUI or RPC client");
			if (params.questions.length === 0) throw new Error("At least one question is required");
			const answers: QuestionAnswer[] = [];
			try {
				for (const prompt of params.questions) answers.push(await askOne(ctx, prompt, signal));
			} catch (error: unknown) {
				if (!(error instanceof QuestionCancelledError)) throw error;
				pi.appendEntry(QUESTION_NOTICE_ENTRY_TYPE, { message: QUESTION_CANCELLED_MESSAGE });
				return {
					content: [{ type: "text", text: QUESTION_CANCELLED_MESSAGE }],
					details: { cancelled: true },
					terminate: true,
				};
			}
			const formatted = formatQuestionAnswers(answers);
			return {
				content: [{ type: "text", text: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.` }],
				details: { answers },
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold(`question (${count})`)), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { answers?: QuestionAnswer[]; cancelled?: boolean } | undefined;
			if (details?.cancelled) return new Text(theme.fg("warning", "Question(s) skipped"), 0, 0);
			if (!details?.answers) return new Text(theme.fg("warning", "Question cancelled"), 0, 0);
			return new Text(details.answers.map((a) => `${theme.fg("success", "✓")} ${a.header}: ${a.answers.join(", ")}`).join("\n"), 0, 0);
		},
	});
}
