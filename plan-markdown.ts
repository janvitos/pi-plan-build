/** Lines outside CommonMark-style backtick/tilde fences, retaining source offsets. */
export function* scanPlanMarkdown(markdown: string): Generator<{ line: string; index: number }> {
	let fence: { char: string; length: number } | undefined;
	for (const [index, line] of markdown.replace(/\r\n?/g, "\n").split("\n").entries()) {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (marker) {
			if (!fence) {
				if (marker[1][0] !== "`" || !marker[2].includes("`")) fence = { char: marker[1][0], length: marker[1].length };
			} else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
			continue;
		}
		if (!fence) yield { line, index };
	}
}
