import assert from "node:assert/strict";
import * as M from "./bundle.mjs";

const hk = M.hk;
let pass = 0;
const t = (name, fn) => {
	try { fn(); pass++; console.log("  ok  " + name); }
	catch (e) { console.log("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
};

// A stand-in for the parts of KeyboardEvent that bindingFromEvent reads.
const evt = (key, mods = {}) => ({
	key,
	ctrlKey: !!mods.ctrl,
	metaKey: !!mods.meta,
	shiftKey: !!mods.shift,
	altKey: !!mods.alt,
});

// ---- the requested defaults ----

t("1-4 are the four grades", () => {
	assert.equal(hk.DEFAULT_HOTKEYS.again, "1");
	assert.equal(hk.DEFAULT_HOTKEYS.hard, "2");
	assert.equal(hk.DEFAULT_HOTKEYS.good, "3");
	assert.equal(hk.DEFAULT_HOTKEYS.easy, "4");
});

t("Space is next card, and is not a grade", () => {
	assert.equal(hk.DEFAULT_HOTKEYS.advance, "Space");
	const grades = ["again", "hard", "good", "easy"];
	assert.ok(!grades.some((g) => hk.DEFAULT_HOTKEYS[g] === "Space"),
		"Space must never be bound to a grade");
});

t("defaults are conflict-free", () => {
	assert.equal(hk.findConflicts(hk.DEFAULT_HOTKEYS).size, 0);
});

t("every action has a default and a description", () => {
	for (const action of hk.REVIEW_ACTIONS) {
		assert.ok(action.id in hk.DEFAULT_HOTKEYS, `${action.id} has no default`);
		assert.ok(action.name.length > 0 && action.desc.length > 0, `${action.id} is undocumented`);
	}
	assert.equal(Object.keys(hk.DEFAULT_HOTKEYS).length, hk.REVIEW_ACTIONS.length,
		"no orphan defaults");
});

// ---- parsing ----

t("Space parses to the key a KeyboardEvent actually reports", () => {
	const parsed = hk.parseHotkey("Space");
	assert.deepEqual(parsed, { modifiers: [], key: " " });
});

t("plain keys parse", () => {
	assert.deepEqual(hk.parseHotkey("1"), { modifiers: [], key: "1" });
	assert.deepEqual(hk.parseHotkey("r"), { modifiers: [], key: "r" });
	assert.deepEqual(hk.parseHotkey("Enter"), { modifiers: [], key: "Enter" });
});

t("modifiers parse in any case and order", () => {
	assert.deepEqual(hk.parseHotkey("Ctrl+r"), { modifiers: ["Ctrl"], key: "r" });
	assert.deepEqual(hk.parseHotkey("ctrl+shift+R"), { modifiers: ["Ctrl", "Shift"], key: "R" });
	assert.deepEqual(hk.parseHotkey("Alt+Meta+Space"), { modifiers: ["Alt", "Meta"], key: " " });
});

t("a literal + is bindable", () => {
	assert.deepEqual(hk.parseHotkey("+"), { modifiers: [], key: "+" });
	assert.deepEqual(hk.parseHotkey("Ctrl++"), { modifiers: ["Ctrl"], key: "+" });
});

t("unbound and malformed parse to null, never throw", () => {
	assert.equal(hk.parseHotkey(""), null);
	assert.equal(hk.parseHotkey("   "), null);
	assert.equal(hk.parseHotkey(undefined), null);
	assert.equal(hk.parseHotkey("Bogus+r"), null, "unknown modifier");
});

// ---- capture ----

t("bindingFromEvent round-trips through parseHotkey", () => {
	const cases = [
		[evt(" "), "Space", " "],
		[evt("1"), "1", "1"],
		[evt("r", { ctrl: true }), "Ctrl+r", "r"],
		[evt("R", { ctrl: true, shift: true }), "Ctrl+Shift+R", "R"],
		[evt("p", { meta: true, alt: true }), "Meta+Alt+p", "p"],
	];
	for (const [e, expected, key] of cases) {
		const binding = hk.bindingFromEvent(e);
		assert.equal(binding, expected);
		assert.equal(hk.parseHotkey(binding).key, key, `round trip for ${expected}`);
	}
});

t("bare modifier presses are rejected as bindings", () => {
	for (const key of ["Shift", "Control", "Alt", "Meta"]) {
		assert.ok(hk.isModifierKey(key), `${key} should be rejected`);
	}
	assert.ok(!hk.isModifierKey("r"));
	assert.ok(!hk.isModifierKey(" "));
});

// ---- conflicts ----

t("conflicts are detected case-insensitively", () => {
	const c = hk.findConflicts({ ...hk.DEFAULT_HOTKEYS, skip: "R" });
	assert.equal(c.size, 1);
	assert.deepEqual(c.get("r").sort(), ["replay", "skip"]);
});

t("unbound actions never conflict with each other", () => {
	const c = hk.findConflicts({ ...hk.DEFAULT_HOTKEYS, skip: "", replay: "", reveal: "" });
	assert.equal(c.size, 0);
});

// ---- withDefaults ----

t("withDefaults fills gaps and honours overrides", () => {
	assert.deepEqual(hk.withDefaults(undefined), hk.DEFAULT_HOTKEYS);
	const merged = hk.withDefaults({ again: "z" });
	assert.equal(merged.again, "z", "override kept");
	assert.equal(merged.good, "3", "gap filled");
	assert.equal(Object.keys(merged).length, hk.REVIEW_ACTIONS.length);
});

t("withDefaults preserves a deliberate unbinding", () => {
	assert.equal(hk.withDefaults({ advance: "" }).advance, "", "empty string is a real choice");
});

t("withDefaults ignores junk values", () => {
	assert.equal(hk.withDefaults({ again: 7 }).again, "1");
	assert.equal(hk.withDefaults({ nonsense: "x" }).good, "3");
});

// ---- display ----

t("displayHotkey labels unbound actions", () => {
	assert.equal(hk.displayHotkey(""), "Not set");
	assert.equal(hk.displayHotkey("  "), "Not set");
	assert.equal(hk.displayHotkey("Ctrl+r"), "Ctrl+r");
});

console.log(`\n${pass} assertions passed`);
