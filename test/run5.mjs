import assert from "node:assert/strict";
import * as M from "./bundle.mjs";

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { console.log("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; } };

// ---- the deck written into a ```flashcard block ----

t("the keyed form is the written form", () => {
  assert.equal(M.parseDeck("deck: language/arabic"), "language/arabic");
  assert.equal(M.parseDeck("deck:language/arabic"), "language/arabic");
  assert.equal(M.parseDeck("DECK:  language/arabic  "), "language/arabic");
});

t("a bare line is a deck too — a deck name cannot contain a colon", () => {
  assert.equal(M.parseDeck("language/arabic"), "language/arabic");
  assert.equal(M.parseDeck("\n\n  msa_vocab \n"), "msa_vocab");
});

t("quotes are stripped", () => {
  assert.equal(M.parseDeck('deck: "language/arabic"'), "language/arabic");
  assert.equal(M.parseDeck("deck: 'msa_vocab'"), "msa_vocab");
});

t("the deck is normalised the way the rest of the plugin normalises it", () => {
  assert.equal(M.parseDeck("deck:  language / arabic / ch1 "), "language/arabic/ch1");
  assert.equal(M.parseDeck("deck: /language/arabic/"), "language/arabic");
});

t("nothing usable means no deck, never a throw", () => {
  assert.equal(M.parseDeck(""), undefined);
  assert.equal(M.parseDeck("   \n  \n"), undefined);
  assert.equal(M.parseDeck("deck:"), undefined);
  assert.equal(M.parseDeck("deck:   "), undefined);
  assert.equal(M.parseDeck("# just a comment"), undefined);
});

t("an unrelated key is not mistaken for a deck", () => {
  assert.equal(M.parseDeck("limit: 20"), undefined);
  assert.equal(M.parseDeck("limit: 20\ndeck: msa_vocab"), "msa_vocab");
});

t("the first deck line wins", () => {
  assert.equal(M.parseDeck("deck: one\ndeck: two"), "one");
});

console.log(`\n${pass} assertions passed`);
