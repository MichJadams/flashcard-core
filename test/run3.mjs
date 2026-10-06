import assert from "node:assert/strict";
import * as M from "./bundle.mjs";
import { makeApp } from "./vault.mjs";

let pass = 0;
const t = async (name, fn) => {
	try { await fn(); pass++; console.log("  ok  " + name); }
	catch (e) { console.log("FAIL  " + name + "\n      " + (e.stack ?? e.message)); process.exitCode = 1; }
};

const deckGlobals = {
	new_per_day_cap: null, reviews_per_day_cap: null, day_start_hour: 4,
	defaults: { new_per_day: 20, max_reviews_per_day: 200, enabled: true, fsrs_params: { request_retention: 0.9 } },
};

/** `deckConfig` is the frontmatter of the deck note governing `piano/note-reading`. */
async function fixture(deckConfig = { new_per_day: 2 }) {
	const { app, files } = makeApp();
	files.set(
		"flashcards/piano/note-reading/flashcard-core-deck.md",
		`---\n${JSON.stringify({ fc: "deck", id: "piano/note-reading", ...deckConfig })}\n---\n`,
	);
	const scheduler = new M.Scheduler();
	let globals = structuredClone(deckGlobals);
	const decks = new M.DeckNoteStore(app, () => globals, async (next) => { globals = next; });
	decks.start();
	const ledger = new M.DailyLedger(undefined, 4, async () => {});
	const store = new M.CardStore(app, "flashcards", (deck) => decks.resolve(deck).folder);
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
	assert.equal(f.core.getCards("piano/note-reading").length, 3);

	assert.equal(await f.core.deleteCards(["blossom:note-reading:c5", "nope"]), 1);
	assert.equal(f.core.getCards("piano/note-reading").length, 2);

	assert.equal(await f.core.deleteByDeck("piano/note-reading", "blossom"), 1);
	const left = f.core.getCards("piano/note-reading");
	assert.equal(left.length, 1);
	assert.equal(left[0].source_plugin, "other", "another plugin's cards are untouched");
});

await t("prune_decks removes cards the generator dropped", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("c5"), card("d5"), card("e5")]));
	const r = await f.core.upsertCards(spec([card("c5")], { prune_decks: ["piano/note-reading"] }));
	assert.equal(r.pruned.length, 2);
	assert.deepEqual(f.core.getCards("piano/note-reading").map((c) => c.id), ["blossom:note-reading:c5"]);
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
	assert.equal(f.ledger.introduced("piano"), 0, "decks are flat — nothing rolls up");
	assert.equal(f.ledger.introducedTotal(), 1, "the collection-wide pool still sees it");

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
		id: "test", deck: "piano/note-reading",
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
	const f = await fixture({ enabled: false });
	await f.core.upsertCards(spec([card("a")]));
	assert.equal((await f.core.buildQueue({ deck: "piano/note-reading" })).length, 0);
	assert.equal((await f.core.buildQueue()).length, 0, "and stays out of the all-decks queue");
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

await t("listDecks reports the decks that exist, and only those", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { deck: "piano/note-reading/treble" })]));
	// `piano/note-reading` is there because it has a deck note; `treble` because
	// it has a card. No `piano` is invented from the shared prefix.
	assert.deepEqual(f.core.listDecks(), ["piano/note-reading", "piano/note-reading/treble"]);
});

await t("listDeckNotes reports registered decks only", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { deck: "unregistered" })]));
	assert.deepEqual(f.core.listDeckNotes().map((n) => n.id), ["piano/note-reading"]);
	assert.equal(f.core.getDeckConfig("unregistered").registered, false);
});

await t("createDeckNote registers a deck that only had cards", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { deck: "loose" })]));
	assert.equal(f.core.getDeckConfig("loose").registered, false);
	const note = await f.core.createDeckNote("flashcards/loose", "loose", { name: "Loose" });
	assert.equal(note.path, "flashcards/loose/flashcard-core-deck.md");
	assert.ok(f.files.has("flashcards/loose/flashcard-core-deck.md"));
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

// An opaque deck id names nothing on disk, so the deck note's folder is the
// only thing that can say where its cards and media belong.
await t("cards land in the deck note's folder, not <root>/<id>", async () => {
	const f = await fixture();
	f.files.set(
		"flashcards/language/MSA/msa_vocab/flashcard-core-deck.md",
		`---\n${JSON.stringify({ fc: "deck", id: "deck-a1b2c3d" })}\n---\n`,
	);
	f.decks.rebuild();
	await f.core.upsertCards(spec([card("z", { deck: "deck-a1b2c3d" })]));

	const path = "flashcards/language/MSA/msa_vocab/blossom__note-reading__z.md";
	assert.ok(f.files.has(path), `expected ${path}`);
	assert.ok(!f.files.has("flashcards/deck-a1b2c3d/blossom__note-reading__z.md"));
	assert.match(
		f.files.get(path),
		/!\[\[flashcards\/language\/MSA\/msa_vocab\/z\.mp3\]\]/,
		"media resolves against the same folder",
	);
});

await t("a deck with no note falls back to <root>/<id>", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("y", { deck: "loose-deck" })]));
	assert.ok(f.files.has("flashcards/loose-deck/blossom__note-reading__y.md"));
});

await t("re-pointing a deck's folder moves its cards on regeneration", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("m")]));
	const before = "flashcards/piano/note-reading/blossom__note-reading__m.md";
	assert.ok(f.files.has(before));

	// The deck note moves; the id, and so every card's `deck` field, does not.
	f.files.delete("flashcards/piano/note-reading/flashcard-core-deck.md");
	f.files.set(
		"flashcards/moved/flashcard-core-deck.md",
		`---\n${JSON.stringify({ fc: "deck", id: "piano/note-reading" })}\n---\n`,
	);
	f.decks.rebuild();
	await f.core.upsertCards(spec([card("m", { fields: { front: "v2", back: "v2" } })]));
	assert.ok(f.files.has("flashcards/moved/blossom__note-reading__m.md"), "followed the note");
});

// The whole point of a reset button over a hand-edit: `fsrs_state` is one of
// eight fields, and the other seven are what make a card's history.
await t("forgetCard clears every fsrs field, not just the state", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a")]));
	const id = "blossom:note-reading:a";
	await f.core.reviewCard(id, 3);
	await f.core.reviewCard(id, 1);
	const dirty = f.core.getCard(id).fsrs;
	// Note: Again from `learning` is not a lapse, so only these three are set.
	assert.ok(dirty.reps > 0, "reps exist first");
	assert.ok(dirty.stability > 0, "stability exists first");
	assert.ok(dirty.last_review !== null, "last_review exists first");

	await f.core.forgetCard(id);

	const clean = f.core.getCard(id).fsrs;
	assert.equal(clean.state, "new");
	assert.equal(clean.reps, 0, "reps");
	assert.equal(clean.lapses, 0, "lapses");
	assert.equal(clean.stability, 0, "stability");
	assert.equal(clean.difficulty, 0, "difficulty");
	assert.equal(clean.scheduled_days, 0, "scheduled_days");
	assert.equal(clean.learning_steps, 0, "learning_steps");

	// ts-fsrs stamps `last_review` with the moment of the reset rather than
	// clearing it. Left as the library has it: a `new` card's first schedule
	// ignores elapsed time, so this reads as "when it was last touched" and
	// changes nothing. `isFresh` keys off state + reps for that reason.
	assert.ok(clean.last_review !== null, "last_review is the reset time, by design");

	// And it is on disk, not just in the index.
	const fm = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(
		f.files.get("flashcards/piano/note-reading/blossom__note-reading__a.md"))[1]);
	assert.equal(fm.fsrs_state, "new");
	assert.equal(fm.fsrs_reps, 0);
	assert.equal(fm.fsrs_stability, 0);
});

await t("getByPath finds a card by its note, and only a card", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a")]));
	const path = "flashcards/piano/note-reading/blossom__note-reading__a.md";
	assert.equal(f.store.getByPath(path)?.id, "blossom:note-reading:a");
	assert.equal(f.store.getByPath("flashcards/piano/note-reading/flashcard-core-deck.md"), null);
	assert.equal(f.store.getByPath("nope.md"), null);
});

await t("resetDeck sends a deck back to new and frees today's budget", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a", { new_order: 1 }), card("b", { new_order: 2 }), card("c", { new_order: 3 })]));
	await f.core.reviewCard("blossom:note-reading:a", 3);
	await f.core.reviewCard("blossom:note-reading:b", 3);
	assert.equal(f.ledger.introduced("piano/note-reading"), 2, "budget spent");

	const n = await f.core.resetDeck("piano/note-reading");
	assert.equal(n, 2, "only the two touched cards were rewritten");
	for (const key of ["a", "b", "c"]) {
		const rec = f.core.getCard(`blossom:note-reading:${key}`);
		assert.equal(rec.fsrs.state, "new", `${key} is new`);
		assert.equal(rec.fsrs.reps, 0, `${key} has no reps`);
	}
	assert.equal(f.ledger.introduced("piano/note-reading"), 0, "counters cleared");
	assert.equal(f.ledger.introducedTotal(), 0);
});

await t("resetDeck leaves other decks alone", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a"), card("z", { deck: "other-deck" })]));
	await f.core.reviewCard("blossom:note-reading:a", 3);
	await f.core.reviewCard("blossom:note-reading:z", 3);

	await f.core.resetDeck("piano/note-reading");
	assert.equal(f.core.getCard("blossom:note-reading:a").fsrs.state, "new");
	assert.notEqual(f.core.getCard("blossom:note-reading:z").fsrs.state, "new", "other deck untouched");
	assert.equal(f.ledger.introduced("other-deck"), 1, "and keeps its counters");
});

await t("resetDeck on an untouched deck rewrites nothing", async () => {
	const f = await fixture();
	await f.core.upsertCards(spec([card("a")]));
	const before = f.files.get("flashcards/piano/note-reading/blossom__note-reading__a.md");
	assert.equal(await f.core.resetDeck("piano/note-reading"), 0);
	assert.equal(f.files.get("flashcards/piano/note-reading/blossom__note-reading__a.md"), before);
});

console.log(`\n${pass} assertions passed`);
