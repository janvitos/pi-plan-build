/** Minimal event fixture: retain all handlers and chain context transformations like Pi. */
export function eventHandlers() {
	const handlers = new Map<string, (...args: any[]) => Promise<any>>();
	return {
		handlers,
		on(name: string, handler: (...args: any[]) => any) {
			const previous = handlers.get(name);
			handlers.set(name, async (event, ctx) => {
				const first = await previous?.(event, ctx);
				if (name === "context" && first?.messages) event = { ...event, messages: first.messages };
				const next = await handler(event, ctx);
				if (name === "before_agent_start") return { ...first, ...next, messages: [...(first?.messages ?? []), ...(next?.message ? [next.message] : [])] };
				return next ?? first;
			});
		},
	};
}
