import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_DELIVERY_TYPE, deliveriesFrom, deliverContext, type Delivery } from "./context-delivery.ts";

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const tool = (id: string, timestamp: number) => ({ role: "toolResult", toolCallId: id, toolName: "plan_finish", content: [{ type: "text", text: "Outcome recorded" }], timestamp });

function session() {
	const journal: Delivery[] = [];
	return { journal, request(messages: any[], state?: string) {
		const result = deliverContext(messages, journal, state);
		if (result.delivery) journal.push(result.delivery);
		return result.messages;
	} };
}

test("unchanged Plan and Build snapshots never relocate across user turns", () => {
	for (const state of ["Plan mode; task 1", "Build mode; task 1"]) {
		const s = session();
		const history = [user("first", 1)];
		const first = s.request(history, state);
		const second = s.request([...history, user("second", 2)], state);
		assert.deepEqual(second.slice(0, first.length), first);
		assert.equal(s.journal.length, 1);
		assert.deepEqual(s.request(second, state), second, "projected input is idempotent too");
		assert.equal(history.length, 1);
	}
});

test("successive synthetic finish updates retain the prefix and use the tool response", () => {
	const s = session();
	const history: any[] = [user("implement", 1)];
	const first = s.request(history, "Build; Outcome null");
	for (let i = 0; i < 3; i++) {
		history.push({ role: "assistant", content: [{ type: "toolCall", id: `f${i}`, name: "plan_finish", arguments: {} }], timestamp: i * 3 + 2 });
		history.push(tool(`f${i}`, i * 3 + 3));
		const response = s.request(history, `Build; awaiting_validation action ${i}`);
		assert.deepEqual(response.slice(0, first.length), first);
		assert.equal(response.at(-1).role, "toolResult");
		assert.match(response.at(-1).content.at(-1).text, new RegExp(`action ${i}`));
		assert.equal(response.filter((m) => m.role === "custom").length, 1, "no synthetic user query after tool calls");
		assert.deepEqual(s.request(history, `Build; awaiting_validation action ${i}`), response);
		assert.deepEqual(s.request(response, `Build; awaiting_validation action ${i}`), response);
		history.push(user("feedback", i * 3 + 4));
	}
	assert.equal(s.journal.length, 4);
});

test("journal survives JSON reload; compaction reseeds; branch state is independent", () => {
	const s = session();
	const messages = [user("plan", 1), tool("finish", 2)];
	const first = s.request(messages, "awaiting validation");
	const entries = JSON.parse(JSON.stringify(s.journal.map((data) => ({ type: "custom", customType: CONTEXT_DELIVERY_TYPE, data }))));
	const journal = deliveriesFrom(entries);
	assert.deepEqual(deliverContext(messages, journal, "awaiting validation").messages, first);
	assert.equal(deliverContext(messages, journal, "awaiting validation").delivery, undefined);
	const compacted = deliverContext([user("summary", 10)], journal, "awaiting validation");
	assert.ok(compacted.delivery, "missing anchor requires a fresh snapshot even for identical state");
	assert.equal(compacted.messages.length, 2);
	const branch = deliverContext([user("branch", 11)], [], "Plan: no task");
	assert.doesNotMatch(JSON.stringify(branch.messages), /awaiting validation/);
});

test("clearing an attachment is explicit, deduplicated and does not erase prior guidance", () => {
	const s = session();
	const history: any[] = [user("implement", 1)];
	const first = s.request(history, "Build; task 1 open");
	history.push(tool("complete", 2));
	const closed = s.request(history);
	assert.deepEqual(closed.slice(0, first.length), first);
	assert.match(closed.at(-1).content.at(-1).text, /Current plan: none/);
	assert.deepEqual(s.request(history), closed);
	assert.equal(s.journal.length, 2);
	assert.deepEqual(session().request([user("ordinary Build", 1)]), [user("ordinary Build", 1)]);
});

test("changes at the same boundary append rather than replace prior state", () => {
	const s = session();
	const messages = [tool("result", 1)];
	const first = s.request(messages, "step running");
	const second = s.request(messages, "step paused; no mutation authorized");
	assert.deepEqual(second[0].content.slice(0, first[0].content.length), first[0].content);
	assert.match(second[0].content.at(-1).text, /step paused/);
});
