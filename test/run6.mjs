import assert from "node:assert/strict";
import * as M from "./bundle.mjs";

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { console.log("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; } };

const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

const item = (id, reason = "new") => ({
  reason,
  card: { id, deck: "d", path: `d/${id}.md`, fsrs: { state: reason === "new" ? "new" : "review", reps: 0 } },
});

const news = (n) => Array.from({ length: n }, (_, i) => item(`n${i + 1}`));
const ids = (session) => session.current?.item.card.id ?? null;

/** Grade the head and return the id that was graded. */
const grade = (s, rating) => { const id = ids(s); s.graded(rating); return id; };

/** Walk a session, grading everything the same way, and record the order shown. */
const walk = (s, rating, max = 100) => {
  const seen = [];
  while (s.current && seen.length < max) seen.push(grade(s, rating));
  return seen;
};

/**
 * The cards a session shows over `n` grades, all graded the same way.
 *
 * Kept well under the retry cap where it is used to check batching: a card
 * dropped for exceeding the cap frees its slot too, which would legitimately
 * admit a sixth card and make a "never a sixth card" assertion a lie about
 * what is being tested.
 */
const distinctOver = (s, rating, n) => {
  const seen = new Set();
  for (let i = 0; i < n && s.current; i++) { seen.add(ids(s)); s.graded(rating); }
  return seen;
};

// ---- the problem this exists to fix ----

t("with everything failed, the same card comes back inside the gap", () => {
  const s = new M.SessionQueue(news(15), { againGap: 3, newBatchSize: 5 });
  const order = walk(s, AGAIN);
  // The gap counts the cards in between: three of them, then n1 is back.
  assert.deepEqual(order.slice(0, 5), ["n1", "n2", "n3", "n4", "n1"]);
});

t("the gap doubles each time a card comes back", () => {
  const s = new M.SessionQueue(news(20), { againGap: 2, newBatchSize: 0 });
  const order = walk(s, AGAIN, 40);
  const first = order.indexOf("n1");
  const second = order.indexOf("n1", first + 1);
  const third = order.indexOf("n1", second + 1);
  assert.equal(second - first - 1, 2, "two cards in between");
  assert.equal(third - second - 1, 4, "then four");
});

t("a card leaves after the retry cap, so a session always ends", () => {
  const s = new M.SessionQueue([item("solo")], { againGap: 3, newBatchSize: 5 });
  const order = walk(s, AGAIN);
  assert.equal(order.length, M.MAX_SESSION_RETRIES + 1, "first sight plus the retries");
  assert.equal(s.current, null);
  assert.equal(s.remaining, 0);
});

t("a session of failures terminates rather than looping", () => {
  const s = new M.SessionQueue(news(15), { againGap: 3, newBatchSize: 5 });
  const order = walk(s, AGAIN, 500);
  assert.equal(s.current, null, "it ended");
  assert.equal(order.length, 15 * (M.MAX_SESSION_RETRIES + 1));
});

// ---- new-card batching ----

t("only a batch of new cards is in flight at once", () => {
  const s = new M.SessionQueue(news(15), { againGap: 3, newBatchSize: 5 });
  assert.equal(s.remaining, 15, "all fifteen are still in the session");
  const shown = distinctOver(s, AGAIN, 20);
  assert.deepEqual([...shown].sort(), ["n1", "n2", "n3", "n4", "n5"], "never a sixth card");
});

t("recalling a card admits the next one", () => {
  const s = new M.SessionQueue(news(15), { againGap: 3, newBatchSize: 5 });
  grade(s, GOOD); // n1 graduates
  const shown = distinctOver(s, AGAIN, 20);
  assert.ok(shown.has("n6"), "n1's slot went to n6");
  assert.ok(!shown.has("n7"), "and no further — one recall, one admission");
});

t("Hard and Easy both count as a recall for batching", () => {
  for (const rating of [HARD, EASY]) {
    const s = new M.SessionQueue(news(15), { againGap: 3, newBatchSize: 5 });
    grade(s, rating);
    assert.ok(distinctOver(s, AGAIN, 20).has("n6"), `rating ${rating} freed the slot`);
  }
});

t("reviews are never held back — the batch is about unseen cards only", () => {
  const queue = [item("r1", "review"), item("r2", "review"), item("r3", "learning"), ...news(10)];
  const s = new M.SessionQueue(queue, { againGap: 0, newBatchSize: 2 });
  const order = walk(s, GOOD);
  assert.deepEqual(order.slice(0, 3), ["r1", "r2", "r3"], "all three came first");
});

t("a review leaving does not free a new-card slot", () => {
  const s = new M.SessionQueue([item("r1", "review"), ...news(10)], { againGap: 0, newBatchSize: 2 });
  grade(s, GOOD); // r1
  grade(s, GOOD); // n1 -> admits n3
  assert.equal(ids(s), "n2");
  s.graded(AGAIN);
  assert.equal(ids(s), "n3", "exactly one card was admitted, by n1 and not by r1");
});

// ---- skipping and dropping ----

t("a skipped card leaves and frees its slot", () => {
  const s = new M.SessionQueue(news(15), { againGap: 3, newBatchSize: 5 });
  s.drop(); // n1 skipped
  const shown = distinctOver(s, AGAIN, 20);
  assert.ok(!shown.has("n1"), "the skipped card did not return");
  assert.ok(shown.has("n6"), "and the batch did not stall");
});

t("a session of skips empties", () => {
  const s = new M.SessionQueue(news(15), { againGap: 3, newBatchSize: 5 });
  for (let i = 0; i < 15; i++) s.drop();
  assert.equal(s.current, null);
  assert.equal(s.remaining, 0);
});

// ---- disabling ----

t("gap 0 runs straight through, exactly as before", () => {
  const s = new M.SessionQueue(news(6), { againGap: 0, newBatchSize: 0 });
  assert.deepEqual(walk(s, AGAIN), ["n1", "n2", "n3", "n4", "n5", "n6"]);
});

t("batch 0 means no batching", () => {
  const s = new M.SessionQueue(news(6), { againGap: 0, newBatchSize: 0 });
  assert.equal(s.heldBack, 0);
});

t("a nonsense config degrades to no pacing rather than throwing", () => {
  const s = new M.SessionQueue(news(4), { againGap: -3, newBatchSize: Number.NaN });
  assert.deepEqual(walk(s, AGAIN), ["n1", "n2", "n3", "n4"]);
});

// ---- bookkeeping ----

t("remaining counts held-back cards, so the header never jumps", () => {
  const s = new M.SessionQueue(news(15), { againGap: 3, newBatchSize: 5 });
  assert.equal(s.remaining, 15);
  assert.equal(s.size, 15);
  grade(s, AGAIN);
  assert.equal(s.remaining, 15, "a returning card is still remaining");
  grade(s, GOOD);
  assert.equal(s.remaining, 14, "a card that leaves is gone");
  assert.equal(s.size, 15, "the session is still fifteen cards");
});

t("the updated record replaces the stale one when a card returns", () => {
  const s = new M.SessionQueue(news(3), { againGap: 1, newBatchSize: 0 });
  const fresh = { id: "n1", deck: "d", path: "d/n1.md", fsrs: { state: "learning", reps: 1 } };
  s.graded(AGAIN, fresh);
  while (ids(s) !== "n1") s.graded(GOOD);
  assert.equal(s.current.item.card.fsrs.state, "learning");
  assert.equal(s.current.item.card.fsrs.reps, 1);
});

t("retries are reported, so the UI can say which attempt this is", () => {
  const s = new M.SessionQueue([item("solo")], { againGap: 3, newBatchSize: 5 });
  assert.equal(s.current.retries, 0);
  s.graded(AGAIN);
  assert.equal(s.current.retries, 1);
  s.graded(AGAIN);
  assert.equal(s.current.retries, 2);
});

t("an empty queue is an empty session", () => {
  const s = new M.SessionQueue([], M.DEFAULT_SESSION_CONFIG);
  assert.equal(s.current, null);
  assert.equal(s.remaining, 0);
  assert.doesNotThrow(() => { s.drop(); s.graded(AGAIN); });
});

console.log(`\n${pass} assertions passed`);
