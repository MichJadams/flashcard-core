import assert from "node:assert/strict";
import * as M from "./bundle.mjs";

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { console.log("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; } };

// ---- scheduler ----
const s = new M.Scheduler();
const now = new Date("2026-08-23T12:00:00Z");
const fresh = s.newState(now);
t("new state is new / zeroed", () => {
  assert.equal(fresh.state, "new");
  assert.equal(fresh.reps, 0);
  assert.equal(fresh.last_review, null);
});

const good = s.grade(fresh, 3, { request_retention: 0.9 }, now);
t("grading a new card advances state", () => {
  assert.notEqual(good.state, "new");
  assert.equal(good.reps, 1);
  assert.ok(new Date(good.due) > now);
  assert.equal(good.last_review, now.toISOString());
});

const again = s.grade(fresh, 1, { request_retention: 0.9 }, now);
t("Again is due sooner than Good", () => {
  assert.ok(new Date(again.due) <= new Date(good.due));
});

// mature card: Easy > Good > Hard > Again intervals
const mature = { due: "2026-08-23T12:00:00Z", stability: 30, difficulty: 5, reps: 8, lapses: 0,
  state: "review", last_review: "2026-07-24T12:00:00Z", learning_steps: 0, scheduled_days: 30 };
const p = s.preview(mature, { request_retention: 0.9, enable_fuzz: false }, now);
t("interval ordering Again <= Hard <= Good <= Easy", () => {
  const d = r => new Date(p[r].due).getTime();
  assert.ok(d(1) <= d(2), "again<=hard"); assert.ok(d(2) <= d(3), "hard<=good"); assert.ok(d(3) <= d(4), "good<=easy");
});
t("preview labels are human", () => {
  assert.match(p[4].interval_label, /^[\d.]+(m|h|d|mo|y)$/);
});
t("lapse increments lapses", () => {
  assert.equal(s.grade(mature, 1, {}, now).lapses, 1);
});
t("retention 0.95 schedules sooner than 0.80", () => {
  const hi = s.grade(mature, 3, { request_retention: 0.95, enable_fuzz: false }, now);
  const lo = s.grade(mature, 3, { request_retention: 0.80, enable_fuzz: false }, now);
  assert.ok(new Date(hi.due) < new Date(lo.due));
});
t("round-trip through frontmatter shape is lossless", () => {
  const a = s.grade(mature, 3, {}, now);
  const b = s.grade(a, 3, {}, new Date(a.due));
  assert.equal(b.reps, a.reps + 1);
});
t("forget resets to new", () => { assert.equal(s.forget(mature, {}, now).state, "new"); });
t("humanInterval formats", () => {
  const f = (ms) => M.humanInterval(now, new Date(now.getTime() + ms));
  assert.equal(f(30_000), "<1m"); assert.equal(f(600_000), "10m");
  assert.equal(f(3 * 3600_000), "3h"); assert.equal(f(5 * 86400_000), "5d");
});

// ---- note helpers ----
const n = M.note;
t("deck ancestry / parent / matches", () => {
  assert.deepEqual(n.deckAncestry("piano/note-reading/treble"), ["piano","piano/note-reading","piano/note-reading/treble"]);
  assert.equal(n.deckParent("piano/note-reading"), "piano");
  assert.equal(n.deckParent("piano"), "");
  assert.ok(n.deckMatches("piano/note-reading", "piano"));
  assert.ok(!n.deckMatches("pianoforte", "piano"));
  assert.ok(n.deckMatches("anything", ""));
});
t("file name is deterministic and path-safe", () => {
  const f = n.fileNameForId("blossom:note-reading:c5-treble");
  assert.equal(f, "blossom__note-reading__c5-treble.md");
  assert.ok(!/[\/:*?"<>|]/.test(f.replace(/\.md$/,"")));
  assert.equal(f, n.fileNameForId("blossom:note-reading:c5-treble"));
});
t("bare media resolves into the deck folder", () => {
  assert.equal(n.mediaEmbed("flashcards","piano/note-reading","c5.mp3"),
    "![[flashcards/piano/note-reading/c5.mp3]]");
  assert.equal(n.mediaEmbed("flashcards","piano","shared/x.png"), "![[shared/x.png]]");
  assert.equal(n.mediaEmbed("flashcards","piano","![[already.png]]"), "![[already.png]]");
});
t("renderBody -> parseBody round trip", () => {
  const body = n.renderBody("flashcards","piano/note-reading", {
    front: "What note is this?", front_image: "treble-c5.png",
    back: "C (third space)", back_audio: "c5.mp3", extra: "Third space of the treble staff.",
  });
  const parsed = n.parseBody(body);
  assert.match(parsed.front, /What note is this\?/);
  assert.match(parsed.front, /!\[\[flashcards\/piano\/note-reading\/treble-c5\.png\]\]/);
  assert.match(parsed.back, /C \(third space\)/);
  assert.match(parsed.back, /c5\.mp3/);
  assert.match(parsed.extra, /Third space/);
});
t("unknown fields fall through to Extra", () => {
  const body = n.renderBody("flashcards","d",{front:"f",back:"b",mnemonic:"Every Good Boy"});
  assert.match(n.parseBody(body).extra, /\*\*mnemonic:\*\* Every Good Boy/);
});
t("hash changes with content, stable otherwise", () => {
  const g = { fc:"card", id:"x:y:z" };
  assert.equal(n.contentHash(g,"body"), n.contentHash(g,"body"));
  assert.notEqual(n.contentHash(g,"body"), n.contentHash(g,"body2"));
});
t("readFsrsState tolerates Date objects and junk", () => {
  const st = n.readFsrsState({ fsrs_due: new Date("2026-01-01T00:00:00Z"), fsrs_state: "bogus" }, "1970-01-01T00:00:00.000Z");
  assert.equal(st.due, "2026-01-01T00:00:00.000Z");
  assert.equal(st.state, "new");
});

// ---- eligibility ----
const card = (id, over) => ({ id, path:`p/${id}.md`, deck:"piano/note-reading", source_plugin:"blossom",
  template:"basic", tags:[], new_order:0, prerequisites:[], gate:null,
  fsrs:{due:"2026-08-23T00:00:00Z",stability:0,difficulty:0,reps:0,lapses:0,state:"new",last_review:null,learning_steps:0,scheduled_days:0},
  ...over });
const idx = (...cs) => new Map(cs.map(c => [c.id, c]));

t("no prerequisites => eligible", () => {
  assert.ok(M.isEligible(card("a"), idx()));
});
t("missing prerequisite blocks", () => {
  const c = card("b", { prerequisites: ["ghost"] });
  assert.ok(!M.isEligible(c, idx(c)));
  assert.deepEqual(M.blockedBy(c, idx(c)), ["ghost (does not exist)"]);
});
t("default gate = prerequisite left new", () => {
  const a = card("a");
  const b = card("b", { prerequisites: ["a"] });
  assert.ok(!M.isEligible(b, idx(a,b)));
  const a2 = card("a", { fsrs: { ...a.fsrs, state:"learning" } });
  assert.ok(M.isEligible(b, idx(a2,b)));
});
t("min_stability gate", () => {
  const a = card("a", { fsrs:{...card("a").fsrs, state:"review", stability:3 } });
  const b = card("b", { prerequisites:["a"], gate:{ min_stability:5 } });
  assert.ok(!M.isEligible(b, idx(a,b)));
  assert.match(M.blockedBy(b, idx(a,b))[0], /stability 3 < 5/);
  const a2 = card("a", { fsrs:{...a.fsrs, stability:5.1 } });
  assert.ok(M.isEligible(b, idx(a2,b)));
});
t("all prerequisites must pass", () => {
  const a = card("a", { fsrs:{...card("a").fsrs, state:"review" } });
  const b = card("b");
  const c = card("c", { prerequisites:["a","b"] });
  assert.ok(!M.isEligible(c, idx(a,b,c)));
});

// ---- provider order resolution ----
t("provider order honoured; unknown ids dropped; omissions withheld", () => {
  const cs = [card("a"), card("b"), card("c")];
  const out = M.resolveProviderOrder(["c","zzz","a","c"], cs, "p");
  assert.deepEqual(out.map(x=>x.id), ["c","a"]);
});
t("non-array provider output falls back to fc_new_order list", () => {
  const cs = [card("a"), card("b")];
  assert.deepEqual(M.resolveProviderOrder(null, cs, "p").map(x=>x.id), ["a","b"]);
});


// ---- audio detection (drives the replay button) ----
t("hasAudio detects ingestion-written embeds", () => {
  assert.ok(M.hasAudio("![[flashcards/piano/note-reading/c5.mp3]]"));
  assert.ok(M.hasAudio("![[c5.wav]]"));
  assert.ok(M.hasAudio("![[c5.m4a|100]]"), "sized embed");
  assert.ok(M.hasAudio("What note?\n\n![[a/b/c5.ogg]]\n"), "embed among prose");
  assert.ok(M.hasAudio("![[C5.MP3]]"), "case insensitive");
  assert.ok(M.hasAudio(null, undefined, "![[x.flac]]"), "scans every part");
});
t("hasAudio ignores non-audio", () => {
  assert.ok(!M.hasAudio("![[treble-c5.png]]"), "image");
  assert.ok(!M.hasAudio("C (third space)"), "plain text");
  assert.ok(!M.hasAudio("[[c5.mp3]]"), "a link is not an embed");
  assert.ok(!M.hasAudio(null, undefined), "nothing at all");
  assert.ok(!M.hasAudio(""), "empty string");
});

console.log(`\n${pass} assertions passed`);
