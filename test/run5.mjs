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

// ---- the default speed written into a ```flashcard block ----

t("default speed is read beside the deck, in either spelling", () => {
  assert.equal(M.parseSpeed("deck: msa_vocab\ndefault speed: 0.75"), 0.75);
  assert.equal(M.parseSpeed("speed: 0.5"), 0.5);
  assert.equal(M.parseSpeed("Default-Speed: .8"), 0.8);
  assert.equal(M.parseSpeed("default_speed: 1.25"), 1.25);
});

t("a speed may be written as a multiplier or a percentage", () => {
  assert.equal(M.parseSpeed("default speed: 0.75x"), 0.75);
  assert.equal(M.parseSpeed("default speed: 75%"), 0.75);
  assert.equal(M.parseSpeed('default speed: "0.6"'), 0.6);
});

t("a speed outside what helps a listener is clamped", () => {
  assert.equal(M.parseSpeed("speed: 0.1"), 0.25);
  assert.equal(M.parseSpeed("speed: 10"), 4);
});

t("no speed, or an unusable one, means normal speed — never a throw", () => {
  assert.equal(M.parseSpeed("deck: msa_vocab"), undefined);
  assert.equal(M.parseSpeed("default speed:"), undefined);
  assert.equal(M.parseSpeed("default speed: slow"), undefined);
  assert.equal(M.parseSpeed("default speed: 0"), undefined);
  assert.equal(M.parseSpeed("default speed: -1"), undefined);
});

t("a speed line is never mistaken for the deck", () => {
  assert.equal(M.parseDeck("default speed: 0.75\ndeck: msa_vocab"), "msa_vocab");
  assert.equal(M.parseDeck("default speed: 0.75"), undefined);
});

console.log(`\n${pass} assertions passed`);
