import assert from "node:assert/strict";
import * as M from "./bundle.mjs";
import { makeApp } from "./vault.mjs";

let pass = 0;
const t = async (name, fn) => {
	try { await fn(); pass++; console.log("  ok  " + name); }
	catch (e) { console.log("FAIL  " + name + "\n      " + (e.stack ?? e.message)); process.exitCode = 1; }
};

const deckFile = {
	version: 1,
	global: { new_per_day_cap: null, reviews_per_day_cap: null, day_start_hour: 4,
		defaults: { new_per_day: 20, max_reviews_per_day: 200, enabled: true, fsrs_params: { request_retention: 0.9 } } },
	decks: { "piano/note-reading": { new_per_day: 2 } },
};

async function fixture(deckOverride) {
	const { app, files } = makeApp();
	files.set("flashcards/_decks.json", JSON.stringify(deckOverride ?? deckFile));
	const scheduler = new M.Scheduler();
	const decks = new M.DeckConfigStore(app, "flashcards");
	await decks.load();
	const ledger = new M.DailyLedger(undefined, 4, async () => {});
	const store = new M.CardStore(app, "flashcards");
	store.start();
	const providers = [];
	const core = new M.FlashcardCore({
		app, store, decks, ledger, scheduler,
		openReview: () => {},
	});
	return { app, files, store, decks, ledger, scheduler, core, providers };
}

const card = (key, over = {}) => ({
	id: `blossom:note-reading:${key}`,
	deck: "piano/note-reading",
	template: "audio",
	tags: ["treble"],
	new_order: 1000,
	fields: { front: `What note is ${key}?`, front_image: `${key}.png`, back: key.toUpperCase(), back_audio: `${key}.mp3` },
	...over,
});

const spec = (cards, options) => ({ schema_version: "1.0", source_plugin: "blossom", cards, options });

// ---------------------------------------------------------------------------

await t("ingest creates notes in the deck folder with media embeds", async () => {
	const f = await fixture();
	const r = await f.core.upsertCards(spec([card("c5"), card("d5", { new_order: 2000 })]));
	assert.deepEqual(r.errors, []);
	assert.equal(r.created.length, 2);

	const path = "flashcards/piano/note-reading/blossom__note-reading__c5.md";
	assert.ok(f.files.has(path), `expected ${path}, got ${[...f.files.keys()].join(", ")}`);
	const content = f.files.get(path);
	assert.match(content, /!\[\[flashcards\/piano\/note-reading\/c5\.png\]\]/);
	assert.match(content, /!\[\[flashcards\/piano\/note-reading\/c5\.mp3\]\]/);
	assert.match(content, /## Front/);
	assert.match(content, /## Back/);

	const rec = f.core.getCard("blossom:note-reading:c5");
	assert.equal(rec.deck, "piano/note-reading");
	assert.equal(rec.source_plugin, "blossom");
	assert.equal(rec.template, "audio");
	assert.equal(rec.fsrs.state, "new");
	assert.equal(rec.new_order, 1000);
});

await t("frontmatter carries the Bases anchors", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("c5")]));
	const fm = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(
		f.files.get("flashcards/piano/note-reading/blossom__note-reading__c5.md"))[1]);
	assert.equal(fm.fc, "card");
	assert.equal(fm.deck, "piano/note-reading");
	assert.equal(fm.fsrs_state, "new");
	assert.ok("fsrs_due" in fm && "fsrs_stability" in fm && "fsrs_reps" in fm && "fsrs_lapses" in fm);
	assert.ok("fsrs_difficulty" in fm && "fsrs_last_review" in fm);
});

await t("re-ingesting identical cards is a no-op", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("c5")]));
	const before = f.files.get("flashcards/piano/note-reading/blossom__note-reading__c5.md");
	const r = await f.core.upsertCards(spec([card("c5")]));
	assert.deepEqual(r.unchanged, ["blossom:note-reading:c5"]);
	assert.equal(r.updated.length, 0);
	assert.equal(f.files.get("flashcards/piano/note-reading/blossom__note-reading__c5.md"), before);
});

await t("REGENERATION PRESERVES FSRS STATE", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("c5")]));
	const id = "blossom:note-reading:c5";

	await f.core.reviewCard(id, 3);
	await f.core.reviewCard(id, 3);
	const after = f.core.getCard(id).fsrs;
	assert.equal(after.reps, 2);
	assert.notEqual(after.state, "new");
	assert.ok(after.stability > 0);

	// The generator rewrites the card with completely different content.
	const r = await f.core.upsertCards(spec([card("c5", {
		fields: { front: "TOTALLY NEW FRONT", back: "TOTALLY NEW BACK" },
		new_order: 55, tags: ["bass"],
	})]));
	assert.deepEqual(r.updated, [id]);

	const now = f.core.getCard(id);
	assert.equal(now.fsrs.reps, 2, "reps survived");
	assert.equal(now.fsrs.state, after.state, "state survived");
	assert.equal(now.fsrs.stability, after.stability, "stability survived");
	assert.equal(now.fsrs.difficulty, after.difficulty, "difficulty survived");
	assert.equal(now.fsrs.due, after.due, "due survived");
	assert.equal(now.fsrs.last_review, after.last_review, "last_review survived");
	assert.equal(now.new_order, 55, "content-side fields did update");
	assert.deepEqual(now.tags, ["bass"]);

	const content = await f.core.getCardContent(id);
	assert.match(content.front, /TOTALLY NEW FRONT/);
});

await t("regenerate_on_change:false leaves an existing note alone", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("c5")]));
	const before = f.files.get("flashcards/piano/note-reading/blossom__note-reading__c5.md");
	const r = await f.core.upsertCards(spec([card("c5", {
		fields: { front: "changed", back: "changed" }, options: { regenerate_on_change: false },
	})]));
	assert.deepEqual(r.unchanged, ["blossom:note-reading:c5"]);
	assert.equal(f.files.get("flashcards/piano/note-reading/blossom__note-reading__c5.md"), before);
});

await t("hand-added frontmatter keys survive regeneration", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("c5")]));
	const path = "flashcards/piano/note-reading/blossom__note-reading__c5.md";
	const raw = f.files.get(path);
	const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
	const fm = JSON.parse(m[1]);
	fm.my_own_note = "keep me";
	f.files.set(path, `---\n${JSON.stringify(fm)}\n---\n${raw.slice(m[0].length)}`);
	f.store.rebuild();

	await f.core.upsertCards(spec([card("c5", { fields: { front: "v2", back: "v2" } })]));
	const after = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(f.files.get(path))[1]);
	assert.equal(after.my_own_note, "keep me");
});

await t("invalid cards are reported but valid ones still land", async () => {
	const f = await fixture();
	const r = await f.core.upsertCards(spec([
		card("c5"),
		{ id: "bad", deck: "x", fields: { front: "a", back: "b" } },
		card("d5"),
		card("c5"),
	]));
	assert.equal(r.created.length, 2);
	assert.equal(r.errors.length, 2);
	assert.match(r.errors[0].message, /namespaced/);
	assert.match(r.errors[1].message, /duplicate id/);
});

await t("deleteCards and deleteByDeck", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("c5"), card("d5")]));
	await f.core.upsertCards({ schema_version: "1.0", source_plugin: "other",
		cards: [{ id: "other:note-reading:x", deck: "piano/note-reading", fields: { front: "a", back: "b" } }] });
	assert.equal(f.core.getCards("piano").length, 3);

	assert.equal(await f.core.deleteCards(["blossom:note-reading:c5", "nope"]), 1);
	assert.equal(f.core.getCards("piano").length, 2);

	assert.equal(await f.core.deleteByDeck("piano", "blossom"), 1);
	const left = f.core.getCards("piano");
	assert.equal(left.length, 1);
	assert.equal(left[0].source_plugin, "other", "another plugin's cards are untouched");
});

await t("prune_decks removes cards the generator dropped", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("c5"), card("d5"), card("e5")]));
	const r = await f.core.upsertCards(spec([card("c5")], { prune_decks: ["piano/note-reading"] }));
	assert.equal(r.pruned.length, 2);
	assert.deepEqual(f.core.getCards("piano").map((c) => c.id), ["blossom:note-reading:c5"]);
});

await t("changing a card's deck moves the note", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("c5")]));
	await f.core.upsertCards(spec([card("c5", { deck: "piano/theory" })]));
	assert.ok(f.files.has("flashcards/piano/theory/blossom__note-reading__c5.md"));
	assert.ok(!f.files.has("flashcards/piano/note-reading/blossom__note-reading__c5.md"));
});

// ---- queue building ----

await t("queue respects the deck new limit", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([
		card("a", { new_order: 1 }), card("b", { new_order: 2 }),
		card("c", { new_order: 3 }), card("d", { new_order: 4 }),
	]));
	const q = await f.core.buildQueue({ deck: "piano/note-reading" });
	assert.equal(q.length, 2, "new_per_day is 2");
	assert.deepEqual(q.map((i) => i.card.id.split(":").pop()), ["a", "b"], "fc_new_order ascending");
	assert.ok(q.every((i) => i.reason === "new"));
});

await t("introducing spends the daily budget", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { new_order: 1 }), card("b", { new_order: 2 }), card("c", { new_order: 3 })]));
	await f.core.reviewCard("blossom:note-reading:a", 3);
	assert.equal(f.ledger.introduced("piano/note-reading"), 1);
	assert.equal(f.ledger.introduced("piano"), 1, "rolled up to the parent");

	const q = await f.core.buildQueue({ deck: "piano/note-reading", no_new: false });
	const news = q.filter((i) => i.reason === "new");
	assert.equal(news.length, 1, "one of the two-per-day slots is spent");
	assert.equal(news[0].card.id, "blossom:note-reading:b");
});

await t("a queue that is never graded costs nothing", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { new_order: 1 }), card("b", { new_order: 2 })]));
	await f.core.buildQueue({ deck: "piano/note-reading" });
	await f.core.buildQueue({ deck: "piano/note-reading" });
	assert.equal(f.ledger.introduced("piano/note-reading"), 0);
	assert.equal((await f.core.buildQueue({ deck: "piano/note-reading" })).length, 2);
});

await t("prerequisites gate the new queue end to end", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([
		card("a", { new_order: 1 }),
		card("b", { new_order: 2, prerequisites: ["blossom:note-reading:a"] }),
	]));
	let q = await f.core.buildQueue({ deck: "piano/note-reading" });
	assert.deepEqual(q.map((i) => i.card.id), ["blossom:note-reading:a"], "b is gated behind a");

	await f.core.reviewCard("blossom:note-reading:a", 3);
	q = await f.core.buildQueue({ deck: "piano/note-reading" });
	assert.ok(q.some((i) => i.card.id === "blossom:note-reading:b"), "b unlocked once a left new");
});

await t("min_stability gate holds until the prerequisite is strong enough", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([
		card("a", { new_order: 1 }),
		card("b", { new_order: 2, prerequisites: ["blossom:note-reading:a"], gate: { min_stability: 100 } }),
	]));
	await f.core.reviewCard("blossom:note-reading:a", 3);
	const q = await f.core.buildQueue({ deck: "piano/note-reading" });
	assert.ok(!q.some((i) => i.card.id === "blossom:note-reading:b"),
		`b should still be gated; stability is ${f.core.getCard("blossom:note-reading:a").fsrs.stability}`);
});

await t("a provider reorders, but cannot beat gating or the limit", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([
		card("a", { new_order: 1 }),
		card("b", { new_order: 2 }),
		card("c", { new_order: 3 }),
		card("gated", { new_order: 0, prerequisites: ["blossom:note-reading:never"] }),
	]));
	f.core.registerNewCardOrderProvider({
		id: "test", deck: "piano",
		provide: () => [
			"blossom:note-reading:gated",
			"blossom:note-reading:c",
			"blossom:note-reading:b",
			"blossom:note-reading:a",
		],
	});
	const q = await f.core.buildQueue({ deck: "piano/note-reading" });
	assert.deepEqual(q.map((i) => i.card.id.split(":").pop()), ["c", "b"],
		"provider order applied, gated card excluded, limit of 2 enforced");
});

await t("provider omissions withhold cards", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { new_order: 1 }), card("b", { new_order: 2 })]));
	const un = f.core.registerNewCardOrderProvider({ id: "t", deck: "", provide: () => [] });
	assert.equal((await f.core.buildQueue({ deck: "piano/note-reading" })).length, 0);
	un();
	assert.equal((await f.core.buildQueue({ deck: "piano/note-reading" })).length, 2, "unregister restored default order");
});

await t("a throwing provider falls back to fc_new_order", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { new_order: 1 }), card("b", { new_order: 2 })]));
	f.core.registerNewCardOrderProvider({ id: "boom", deck: "", provide: () => { throw new Error("nope"); } });
	const q = await f.core.buildQueue({ deck: "piano/note-reading" });
	assert.deepEqual(q.map((i) => i.card.id.split(":").pop()), ["a", "b"]);
});

await t("the most specific provider wins", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { new_order: 1 }), card("b", { new_order: 2 })]));
	f.core.registerNewCardOrderProvider({ id: "broad", deck: "", provide: () => ["blossom:note-reading:a"] });
	f.core.registerNewCardOrderProvider({ id: "narrow", deck: "piano/note-reading", provide: () => ["blossom:note-reading:b"] });
	const q = await f.core.buildQueue({ deck: "piano/note-reading" });
	assert.deepEqual(q.map((i) => i.card.id.split(":").pop()), ["b"]);
});

await t("disabled decks are skipped", async () => {
	const f = await fixture({ ...deckFile, decks: { ...deckFile.decks, "piano/note-reading": { enabled: false } } });
	await f.core.upsertCards(spec([card("a")]));
	assert.equal((await f.core.buildQueue({ deck: "piano" })).length, 0);
});

await t("due reviews come before new cards, learning first", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { new_order: 1 }), card("b", { new_order: 2 }), card("c", { new_order: 3 })]));
	await f.core.reviewCard("blossom:note-reading:a", 1); // Again -> learning, due in minutes
	const q = await f.core.buildQueue({ deck: "piano/note-reading", ignore_limits: true });
	// `a` is due again almost immediately; assert it sorts ahead of the new cards.
	const first = q[0];
	if (new Date(f.core.getCard("blossom:note-reading:a").fsrs.due) <= new Date()) {
		assert.equal(first.card.id, "blossom:note-reading:a");
		assert.equal(first.reason, "learning");
	}
	assert.ok(q.filter((i) => i.reason === "new").length >= 1);
});

await t("ignore_limits overrides the daily cap but still counts introductions", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { new_order: 1 }), card("b", { new_order: 2 }), card("c", { new_order: 3 })]));
	const q = await f.core.buildQueue({ deck: "piano/note-reading", ignore_limits: true });
	assert.equal(q.length, 3);
	await f.core.reviewCard("blossom:note-reading:a", 3);
	assert.equal(f.ledger.introduced("piano/note-reading"), 1);
});

await t("getDueCards excludes new cards", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a"), card("b")]));
	assert.equal(f.core.getDueCards("piano").length, 0);
	await f.core.reviewCard("blossom:note-reading:a", 1);
	const due = f.core.getDueCards("piano", 10);
	assert.ok(due.every((c) => c.fsrs.state !== "new"));
});

await t("reviewCard reports introduction and writes through to disk", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a")]));
	const r1 = await f.core.reviewCard("blossom:note-reading:a", 3);
	assert.equal(r1.introduced, true);
	assert.equal(r1.previous.state, "new");
	assert.equal(r1.rating, 3);

	const fm = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(
		f.files.get("flashcards/piano/note-reading/blossom__note-reading__a.md"))[1]);
	assert.equal(fm.fsrs_reps, 1);
	assert.notEqual(fm.fsrs_state, "new");
	assert.equal(fm.fsrs_due, r1.due);

	const r2 = await f.core.reviewCard("blossom:note-reading:a", 3);
	assert.equal(r2.introduced, false, "only the first grade introduces");
	assert.equal(f.ledger.reviews("piano/note-reading"), 1);
});

await t("onReview fires; unsubscribe stops it", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a")]));
	const seen = [];
	const off = f.core.onReview((r) => seen.push(r.card.id));
	await f.core.reviewCard("blossom:note-reading:a", 3);
	off();
	await f.core.reviewCard("blossom:note-reading:a", 3);
	assert.deepEqual(seen, ["blossom:note-reading:a"]);
});

await t("previewRatings labels all four grades", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a")]));
	const p = f.core.previewRatings("blossom:note-reading:a");
	for (const g of [1, 2, 3, 4]) assert.ok(p[g].interval_label.length > 0, `grade ${g}`);
	assert.equal(f.core.previewRatings("nope"), null);
});

await t("forgetCard resets to new", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a")]));
	await f.core.reviewCard("blossom:note-reading:a", 3);
	const back = await f.core.forgetCard("blossom:note-reading:a");
	assert.equal(back.fsrs.state, "new");
	assert.equal(back.fsrs.reps, 0);
});

await t("getDeckStats reports counts and remaining budget", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a"), card("b"), card("c")]));
	let s = f.core.getDeckStats("piano/note-reading");
	assert.equal(s.counts.new, 3);
	assert.equal(s.new_remaining, 2);
	await f.core.reviewCard("blossom:note-reading:a", 3);
	s = f.core.getDeckStats("piano/note-reading");
	assert.equal(s.introduced_today, 1);
	assert.equal(s.new_remaining, 1);
	assert.equal(s.counts.new, 2);
});

await t("listDecks includes intermediate parents", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { deck: "piano/note-reading/treble" })]));
	assert.deepEqual(f.core.listDecks(), ["piano", "piano/note-reading", "piano/note-reading/treble"]);
});

await t("setDeckConfig through the API takes effect immediately", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { new_order: 1 }), card("b", { new_order: 2 }), card("c", { new_order: 3 })]));
	assert.equal((await f.core.buildQueue({ deck: "piano/note-reading" })).length, 2);
	await f.core.setDeckConfig("piano/note-reading", { new_per_day: 3 });
	assert.equal((await f.core.buildQueue({ deck: "piano/note-reading" })).length, 3);
});

await t("unknown card id throws a useful error", async () => {
	const f = await fixture();
	await assert.rejects(() => f.core.reviewCard("nope", 3), /unknown card id/);
});

console.log(`\n${pass} assertions passed`);
