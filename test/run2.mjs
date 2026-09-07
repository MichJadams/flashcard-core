import assert from "node:assert/strict";
import * as M from "./bundle.mjs";
import { makeApp } from "./vault.mjs";

let pass = 0;
const t = (name, fn) => {
	const ok = () => { pass++; console.log("  ok  " + name); };
	const bad = (e) => { console.log("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; };
	try { const out = fn(); if (out instanceof Promise) return out.then(ok, bad); ok(); }
	catch (e) { bad(e); }
};

// ---- deck notes ----
// Decks are flat: a deck note's own fields, then the global defaults, and
// nowhere else. The fake vault stores frontmatter as JSON, which the stubbed
// parseYaml round-trips through the same code paths.
const GLOBAL = {
	new_per_day_cap: 30,
	reviews_per_day_cap: null,
	day_start_hour: 4,
	defaults: {
		new_per_day: 20,
		max_reviews_per_day: 200,
		enabled: true,
		fsrs_params: { request_retention: 0.9 },
	},
};

function makeStore(notes = {}, global = GLOBAL) {
	const { app, files } = makeApp();
	for (const [path, fm] of Object.entries(notes)) {
		files.set(path, `---\n${JSON.stringify(fm)}\n---\n`);
	}
	let current = structuredClone(global);
	const store = new M.DeckNoteStore(app, () => current, async (next) => { current = next; });
	store.start();
	return { store, files };
}

const NOTES = {
	"cards/piano/flashcard-core-deck.md": {
		fc: "deck", id: "piano", name: "Piano", new_per_day: 10,
		fsrs_params: { request_retention: 0.85, learning_steps: ["1m", "10m"] },
	},
	"cards/reading/flashcard-core-deck.md": { fc: "deck", id: "note-reading", new_per_day: 4 },
	"cards/rhythm/flashcard-core-deck.md": { fc: "deck", id: "rhythm", enabled: false },
};

await t("defaults apply to a deck with no note", () => {
	const { store } = makeStore();
	const r = store.resolve("piano");
	assert.equal(r.new_per_day, 20);
	assert.equal(r.max_reviews_per_day, 200);
	assert.equal(r.enabled, true);
	assert.equal(r.fsrs_params.request_retention, 0.9);
	assert.equal(r.registered, false, "and it says so");
	assert.equal(r.path, null);
});

await t("a deck note overrides only the fields it sets", () => {
	const { store } = makeStore(NOTES);
	const r = store.resolve("piano");
	assert.equal(r.new_per_day, 10, "from the note");
	assert.equal(r.max_reviews_per_day, 200, "from the global defaults");
	assert.equal(r.fsrs_params.request_retention, 0.85);
	assert.deepEqual(r.fsrs_params.learning_steps, ["1m", "10m"]);
	assert.equal(r.registered, true);
	assert.equal(r.path, "cards/piano/flashcard-core-deck.md");
	assert.equal(r.folder, "cards/piano");
});

await t("name falls back to the id", () => {
	const { store } = makeStore(NOTES);
	assert.equal(store.resolve("piano").name, "Piano");
	assert.equal(store.resolve("note-reading").name, "note-reading");
});

await t("a deck id is not a path — nothing inherits", () => {
	const { store } = makeStore(NOTES);
	// `piano` sets 10/day; a deck whose id merely starts with it is unaffected.
	assert.equal(store.resolve("piano/note-reading").new_per_day, 20);
	assert.equal(store.resolve("piano/note-reading").registered, false);
});

await t("enabled=false applies to that deck alone", () => {
	const { store } = makeStore(NOTES);
	assert.equal(store.resolve("rhythm").enabled, false);
	assert.equal(store.resolve("piano").enabled, true);
});

await t("the id and its folder are independent", () => {
	const { store } = makeStore(NOTES);
	// id `note-reading`, in a folder called `reading`.
	assert.equal(store.resolve("note-reading").folder, "cards/reading");
});

await t("two notes claiming one id: first by path wins", () => {
	const { store } = makeStore({
		"b/flashcard-core-deck.md": { fc: "deck", id: "dup", new_per_day: 2 },
		"a/flashcard-core-deck.md": { fc: "deck", id: "dup", new_per_day: 1 },
	});
	assert.equal(store.resolve("dup").new_per_day, 1);
	assert.equal(store.all().length, 1);
});

await t("a note without fc: deck is not a deck", () => {
	const { store } = makeStore({ "x/flashcard-core-deck.md": { id: "x", new_per_day: 3 } });
	assert.equal(store.all().length, 0);
	assert.equal(store.resolve("x").registered, false);
});

await t("malformed fields are ignored, not fatal", () => {
	const { store } = makeStore({
		"x/flashcard-core-deck.md": {
			fc: "deck", id: "x", new_per_day: "lots", enabled: "yes", name: "X",
		},
	});
	const r = store.resolve("x");
	assert.equal(r.new_per_day, 20, "fell back to the default");
	assert.equal(r.enabled, true);
	assert.equal(r.name, "X", "the good field survived");
});

await t("set() writes frontmatter; undefined clears back to the default", async () => {
	const { store } = makeStore(NOTES);
	await store.set("piano", { new_per_day: 7, fsrs_params: { maximum_interval: 365 } });
	const r = store.resolve("piano");
	assert.equal(r.new_per_day, 7);
	assert.equal(r.fsrs_params.maximum_interval, 365);
	assert.equal(r.fsrs_params.request_retention, 0.85, "the other fsrs field survived the merge");
	await store.set("piano", { new_per_day: undefined });
	assert.equal(store.resolve("piano").new_per_day, 20, "back to the global default");
});

await t("set() refuses a deck that has no note", async () => {
	const { store } = makeStore(NOTES);
	await assert.rejects(() => store.set("nope", { new_per_day: 1 }), /no deck note/);
});

await t("createNote writes a usable deck note", async () => {
	const { store, files } = makeStore();
	const note = await store.createNote("cards/new-deck", "new-deck", { name: "Fresh", new_per_day: 3 });
	assert.equal(note.id, "new-deck");
	assert.equal(note.path, "cards/new-deck/flashcard-core-deck.md");
	assert.equal(note.folder, "cards/new-deck");
	const body = files.get("cards/new-deck/flashcard-core-deck.md");
	assert.match(body, /fc: deck/);
	assert.match(body, /id: new-deck/);
	assert.match(body, /new_per_day: 3/);
	assert.match(body, /flashcard-deck-stats/, "ships with its stats block");
	assert.match(body, /flashcard-deck-settings/, "and its settings block");
});

await t("createNote is idempotent", async () => {
	const { store } = makeStore(NOTES);
	const note = await store.createNote("cards/piano", "piano");
	assert.equal(note.path, "cards/piano/flashcard-core-deck.md");
	assert.equal(store.all().length, 3, "no second deck appeared");
});

await t("createNote refuses an empty id", async () => {
	const { store } = makeStore();
	await assert.rejects(() => store.createNote("cards/x", "  /  "), /needs an id/);
});

await t("global defaults are read live, not snapshotted", async () => {
	const { store } = makeStore();
	assert.equal(store.resolve("x").new_per_day, 20);
	await store.setGlobal({ defaults: { new_per_day: 5 } });
	assert.equal(store.resolve("x").new_per_day, 5);
	assert.equal(store.global().defaults.max_reviews_per_day, 200, "untouched fields survive");
});

await t("deck discovery follows the vault", () => {
	const { store, files } = makeStore(NOTES);
	assert.equal(store.raw("late-arrival"), null);
	files.set("cards/late/flashcard-core-deck.md", `---\n${JSON.stringify({ fc: "deck", id: "late-arrival" })}\n---\n`);
	store.rebuild();
	assert.equal(store.raw("late-arrival")?.folder, "cards/late");
});

await t("byRef takes an id, a name, or neither", () => {
	const { store } = makeStore(NOTES);
	assert.equal(store.byRef("piano"), "piano", "an id passes through");
	assert.equal(store.byRef("Piano"), "piano", "so does the display name");
	assert.equal(store.byRef("  PIANO  "), "piano", "case and padding are forgiven");
	assert.equal(store.byRef("note-reading"), "note-reading", "id wins when there is no name");
	assert.equal(store.byRef("nobody"), "nobody", "an unknown ref is handed back as-is");
	assert.equal(store.byRef(""), "");
});

await t("byRef survives opaque ids, which is the point of names", () => {
	const { store } = makeStore({
		"cards/x/flashcard-core-deck.md": { fc: "deck", id: "deck-a1b2c3d", name: "MSA vocabulary" },
	});
	assert.equal(store.byRef("MSA vocabulary"), "deck-a1b2c3d");
	assert.equal(store.byRef("deck-a1b2c3d"), "deck-a1b2c3d");
});

await t("folderForCards picks the most common folder", () => {
	assert.equal(M.folderForCards(["a/b/1.md", "a/b/2.md", "a/c/3.md"]), "a/b");
	assert.equal(M.folderForCards([]), null);
});

// ---- daily ledger ----
await t("dayKey respects the rollover hour", () => {
	assert.equal(M.dayKey(new Date("2026-08-23T03:00:00"), 4), "2026-08-22");
	assert.equal(M.dayKey(new Date("2026-08-23T05:00:00"), 4), "2026-08-23");
	assert.equal(M.dayKey(new Date("2026-08-23T03:00:00"), 0), "2026-08-23");
});

await t("a counter belongs to exactly one deck", async () => {
	const l = new M.DailyLedger(undefined, 4, async () => {});
	await l.recordIntroduction("piano/note-reading");
	await l.recordIntroduction("piano/rhythm");
	assert.equal(l.introduced("piano/note-reading"), 1);
	assert.equal(l.introduced("piano"), 0, "no roll-up: these are unrelated decks");
	assert.equal(l.introducedTotal(), 2, "but the global pool sees both");
	assert.equal(l.reviews("piano/note-reading"), 0, "reviews are a separate pool");
});

await t("counters reset when the day rolls over", () => {
	const l = new M.DailyLedger(M.emptyDaily("2020-01-01"), 4, async () => {});
	assert.equal(l.introduced("piano"), 0);
	assert.notEqual(l.current().day, "2020-01-01");
});

// ---- budgets ----
const now = new Date("2026-08-23T12:00:00Z");
async function budgetFixture(spent = []) {
	const { store } = makeStore(NOTES);
	const l = new M.DailyLedger(undefined, 4, async () => {});
	for (const deck of spent) await l.recordIntroduction(deck, now);
	return { d: store, l };
}

await t("each deck gets its own limit", async () => {
	const { d, l } = await budgetFixture();
	const b = M.Budget.forNew(d, l, now);
	assert.equal(b.remaining("note-reading", "new"), 4);
	assert.equal(b.remaining("piano", "new"), 10);
});

await t("spending one deck leaves the others untouched", async () => {
	const { d, l } = await budgetFixture();
	const b = M.Budget.forNew(d, l, now);
	for (let i = 0; i < 4; i++) b.take("note-reading", "new");
	assert.equal(b.remaining("note-reading", "new"), 0, "exhausted");
	assert.equal(b.remaining("piano", "new"), 10, "a different deck is a different budget");
});

await t("already-spent introductions reduce today's budget", async () => {
	const { d, l } = await budgetFixture(["note-reading", "note-reading"]);
	const b = M.Budget.forNew(d, l, now);
	assert.equal(b.remaining("note-reading", "new"), 2);
	assert.equal(b.remaining("piano", "new"), 10);
});

await t("global cap floors every deck", async () => {
	const { d, l } = await budgetFixture();
	for (let i = 0; i < 29; i++) await l.recordIntroduction("somewhere-else", now);
	const b = M.Budget.forNew(d, l, now);
	assert.equal(b.remaining("note-reading", "new"), 1, "global cap 30 minus 29 spent");
});

await t("an unregistered deck still gets the default budget", async () => {
	const { d, l } = await budgetFixture();
	const b = M.Budget.forNew(d, l, now);
	assert.equal(b.remaining("brand-new-deck", "new"), 20, "reviewable, not frozen out");
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
	for (let i = 0; i < 4; i++) b.take("note-reading", "new");
	const r = M.Budget.forReviews(d, l, now);
	assert.equal(r.remaining("note-reading", "review"), 200);
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
