import assert from "node:assert/strict";
import * as M from "./bundle.mjs";

let pass = 0;
const t = (name, fn) => {
	const ok = () => { pass++; console.log("  ok  " + name); };
	const bad = (e) => { console.log("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; };
	try { const out = fn(); if (out instanceof Promise) return out.then(ok, bad); ok(); }
	catch (e) { bad(e); }
};

// ---- deck config inheritance ----
function makeStore(file) {
	const fs = new Map();
	if (file) fs.set("flashcards/_decks.json", JSON.stringify(file));
	const app = { vault: {
		adapter: { exists: async (p) => fs.has(p), read: async (p) => fs.get(p), write: async (p, v) => { fs.set(p, v); } },
		createFolder: async () => {},
	}};
	return new M.DeckConfigStore(app, "flashcards");
}

await t("defaults apply when nothing is configured", async () => {
	const d = makeStore(null); await d.load();
	const r = d.resolve("piano/note-reading");
	assert.equal(r.new_per_day, 20);
	assert.equal(r.max_reviews_per_day, 200);
	assert.equal(r.enabled, true);
	assert.equal(r.fsrs_params.request_retention, 0.9);
});

const file = {
	version: 1,
	global: { new_per_day_cap: 30, reviews_per_day_cap: null, day_start_hour: 4,
		defaults: { new_per_day: 20, max_reviews_per_day: 200, enabled: true, fsrs_params: { request_retention: 0.9 } } },
	decks: {
		"piano": { new_per_day: 10, fsrs_params: { request_retention: 0.85, learning_steps: ["1m", "10m"] } },
		"piano/note-reading": { new_per_day: 4 },
		"piano/rhythm": { enabled: false },
		"language": { inherits: "piano" },
		"loop-a": { inherits: "loop-b" },
		"loop-b": { inherits: "loop-a" },
	},
};

await t("child inherits parent, overrides its own field", async () => {
	const d = makeStore(file); await d.load();
	const r = d.resolve("piano/note-reading");
	assert.equal(r.new_per_day, 4, "own override");
	assert.equal(r.max_reviews_per_day, 200, "from global defaults");
	assert.equal(r.fsrs_params.request_retention, 0.85, "inherited from piano");
	assert.deepEqual(r.fsrs_params.learning_steps, ["1m", "10m"]);
	assert.deepEqual(r.chain, ["piano/note-reading", "piano"]);
});

await t("unconfigured grandchild inherits through the chain", async () => {
	const d = makeStore(file); await d.load();
	const r = d.resolve("piano/note-reading/treble");
	assert.equal(r.new_per_day, 4);
	assert.equal(r.fsrs_params.request_retention, 0.85);
	assert.deepEqual(r.chain, ["piano/note-reading/treble", "piano/note-reading", "piano"]);
});

await t("explicit inherits overrides the path parent", async () => {
	const d = makeStore(file); await d.load();
	assert.equal(d.resolve("language").new_per_day, 10);
	assert.equal(d.resolve("language").fsrs_params.request_retention, 0.85);
});

await t("enabled=false propagates to children", async () => {
	const d = makeStore(file); await d.load();
	assert.equal(d.resolve("piano/rhythm").enabled, false);
	assert.equal(d.resolve("piano/rhythm/subdivision").enabled, false);
	assert.equal(d.resolve("piano/note-reading").enabled, true);
});

await t("inherits cycle terminates instead of hanging", async () => {
	const d = makeStore(file); await d.load();
	const r = d.resolve("loop-a");
	assert.deepEqual(r.chain, ["loop-a", "loop-b"]);
	assert.equal(r.new_per_day, 20);
});

await t("setDeckConfig merges and persists; undefined clears", async () => {
	const d = makeStore(file); await d.load();
	await d.set("piano/note-reading", { new_per_day: 7, fsrs_params: { maximum_interval: 365 } });
	const r = d.resolve("piano/note-reading");
	assert.equal(r.new_per_day, 7);
	assert.equal(r.fsrs_params.maximum_interval, 365);
	assert.equal(r.fsrs_params.request_retention, 0.85, "parent value survives the merge");
	await d.set("piano/note-reading", { new_per_day: undefined });
	assert.equal(d.resolve("piano/note-reading").new_per_day, 10, "falls back to piano");
});

await t("corrupt json falls back to defaults", async () => {
	const app = { vault: { adapter: { exists: async () => true, read: async () => "{not json", write: async () => {} }, createFolder: async () => {} } };
	const d = new M.DeckConfigStore(app, "flashcards");
	await d.load();
	assert.equal(d.resolve("x").new_per_day, 20);
});

// ---- daily ledger ----
await t("dayKey respects the rollover hour", () => {
	assert.equal(M.dayKey(new Date("2026-08-23T03:00:00"), 4), "2026-08-22");
	assert.equal(M.dayKey(new Date("2026-08-23T05:00:00"), 4), "2026-08-23");
	assert.equal(M.dayKey(new Date("2026-08-23T03:00:00"), 0), "2026-08-23");
});

await t("introductions roll up the deck hierarchy", async () => {
	const l = new M.DailyLedger(undefined, 4, async () => {});
	await l.recordIntroduction("piano/note-reading");
	await l.recordIntroduction("piano/rhythm");
	assert.equal(l.introduced("piano/note-reading"), 1);
	assert.equal(l.introduced("piano"), 2, "parent sees both");
	assert.equal(l.introducedTotal(), 2);
	assert.equal(l.reviews("piano"), 0, "reviews are a separate pool");
});

await t("counters reset when the day rolls over", () => {
	const l = new M.DailyLedger(M.emptyDaily("2020-01-01"), 4, async () => {});
	assert.equal(l.introduced("piano"), 0);
	assert.notEqual(l.current().day, "2020-01-01");
});

// ---- budgets ----
const now = new Date("2026-08-23T12:00:00Z");
async function budgetFixture(spent = []) {
	const d = makeStore(file); await d.load();
	const l = new M.DailyLedger(undefined, 4, async () => {});
	for (const deck of spent) await l.recordIntroduction(deck, now);
	return { d, l };
}

await t("child limit caps below parent", async () => {
	const { d, l } = await budgetFixture();
	const b = M.Budget.forNew(d, l, now);
	assert.equal(b.remaining("piano/note-reading", "new"), 4);
	assert.equal(b.remaining("piano", "new"), 10);
});

await t("parent limit caps the whole subtree", async () => {
	const { d, l } = await budgetFixture();
	const b = M.Budget.forNew(d, l, now);
	for (let i = 0; i < 4; i++) b.take("piano/note-reading", "new");
	assert.equal(b.remaining("piano/note-reading", "new"), 0, "child exhausted");
	assert.equal(b.remaining("piano/theory", "new"), 6, "sibling sees the parent budget already partly spent");
	for (let i = 0; i < 6; i++) b.take("piano/theory", "new");
	assert.equal(b.remaining("piano", "new"), 0, "parent exhausted by its children");
});

await t("already-spent introductions reduce today's budget", async () => {
	const { d, l } = await budgetFixture(["piano/note-reading", "piano/note-reading"]);
	const b = M.Budget.forNew(d, l, now);
	assert.equal(b.remaining("piano/note-reading", "new"), 2);
	assert.equal(b.remaining("piano", "new"), 8);
});

await t("global cap floors every deck", async () => {
	const { d, l } = await budgetFixture();
	for (let i = 0; i < 29; i++) await l.recordIntroduction("language", now);
	const b = M.Budget.forNew(d, l, now);
	assert.equal(b.remaining("piano/note-reading", "new"), 1, "global cap 30 minus 29 spent");
});

await t("unlimited budget never refuses", () => {
	const b = M.Budget.unlimited();
	assert.equal(b.remaining("anything", "new"), Infinity);
	for (let i = 0; i < 1000; i++) b.take("anything", "new");
	assert.equal(b.remaining("anything", "new"), Infinity);
});

await t("review budget is independent of the new budget", async () => {
	const { d, l } = await budgetFixture();
	const b = M.Budget.forNew(d, l, now);
	for (let i = 0; i < 4; i++) b.take("piano/note-reading", "new");
	const r = M.Budget.forReviews(d, l, now);
	assert.equal(r.remaining("piano/note-reading", "review"), 200);
});

// ---- ingest validation ----
const envelope = { schema_version: "1.0", source_plugin: "blossom", cards: [] };
await t("envelope validation", () => {
	assert.equal(M.validateSpec(envelope), null);
	assert.match(M.validateSpec({ ...envelope, schema_version: "2.0" }), /unsupported schema_version/);
	assert.equal(M.validateSpec({ ...envelope, schema_version: "1.7" }), null, "minor versions accepted");
	assert.match(M.validateSpec({ ...envelope, source_plugin: "" }), /source_plugin/);
	assert.match(M.validateSpec({ ...envelope, cards: "nope" }), /cards/);
	assert.match(M.validateSpec("string"), /JSON object/);
});

await t("card validation", () => {
	const good = { id: "p:d:k", deck: "piano/x", fields: { front: "f", back: "b" } };
	assert.ok("spec" in M.validateCard(good, 0));
	assert.match(M.validateCard({ ...good, id: "nonamespace" }, 0).error.message, /namespaced/);
	assert.match(M.validateCard({ ...good, deck: "  /  " }, 0).error.message, /deck/);
	assert.match(M.validateCard({ ...good, fields: { front: "", back: "b" } }, 0).error.message, /front/);
	assert.match(M.validateCard({ ...good, new_order: "1" }, 0).error.message, /new_order/);
	assert.match(M.validateCard({ ...good, prerequisites: ["p:d:k"] }, 0).error.message, /own prerequisite/);
	assert.match(M.validateCard({ ...good, prerequisites: [3] }, 0).error.message, /prerequisites/);
	assert.match(M.validateCard(null, 0).error.message, /expected an object/);
	assert.ok("spec" in M.validateCard({ ...good, future_key: "tolerated" }, 0), "unknown keys allowed");
});

console.log(`\n${pass} assertions passed`);
