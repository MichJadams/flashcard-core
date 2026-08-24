/**
 * Review-modal hotkeys.
 *
 * These cannot use Obsidian's native Hotkeys pane: that only binds commands
 * registered with `addCommand`, which are global, whereas these keys must be
 * live only while the reviewer is open and must mean different things depending
 * on whether the answer is showing. So the bindings live in plugin settings and
 * are registered on the modal's own `Scope`.
 *
 * Bindings are stored in their display form (`"Space"`, `"Ctrl+r"`, `"1"`), so
 * `data.json` stays legible and hand-editable.
 */

import type { Modifier } from "obsidian";

/** Everything the reviewer can be asked to do. */
export type ReviewActionId =
	| "advance"
	| "reveal"
	| "again"
	| "hard"
	| "good"
	| "easy"
	| "skip"
	| "replay";

export interface ReviewActionSpec {
	id: ReviewActionId;
	name: string;
	desc: string;
}

/** Display order in the settings tab. */
export const REVIEW_ACTIONS: readonly ReviewActionSpec[] = [
	{
		id: "advance",
		name: "Next card",
		desc: "Reveals the answer if it is hidden; once it is showing, moves to the next card without grading.",
	},
	{
		id: "reveal",
		name: "Reveal answer",
		desc: "Shows the back of the card. Does nothing once it is already showing.",
	},
	{ id: "again", name: "Grade: Again", desc: "You did not recall it. The card comes back within minutes." },
	{ id: "hard", name: "Grade: Hard", desc: "Recalled, but with difficulty." },
	{ id: "good", name: "Grade: Good", desc: "Recalled correctly." },
	{ id: "easy", name: "Grade: Easy", desc: "Recalled instantly. The card is pushed out furthest." },
	{ id: "skip", name: "Skip card", desc: "Moves on without recording anything." },
	{ id: "replay", name: "Replay audio", desc: "Restarts the audio on the side currently showing." },
];

/**
 * Default bindings.
 *
 * Grading lives exclusively on 1-4, and Space only ever moves you forward — it
 * never records a grade. That separation is deliberate: a key you press to
 * advance should not silently write to your review history.
 */
export const DEFAULT_HOTKEYS: Record<ReviewActionId, string> = {
	advance: "Space",
	reveal: "Enter",
	again: "1",
	hard: "2",
	good: "3",
	easy: "4",
	skip: "u",
	replay: "r",
};

// ---------------------------------------------------------------------------
// Binding strings
// ---------------------------------------------------------------------------

const MODIFIERS: Modifier[] = ["Ctrl", "Meta", "Shift", "Alt"];
const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph", "CapsLock", "Dead"]);

/** Keys whose `KeyboardEvent.key` is not a sensible thing to show a user. */
const KEY_TO_DISPLAY: Record<string, string> = { " ": "Space" };
const DISPLAY_TO_KEY: Record<string, string> = { Space: " " };

export interface ParsedHotkey {
	modifiers: Modifier[];
	/** The value to match against `KeyboardEvent.key`. */
	key: string;
}

/** `true` if the event is a bare modifier press, which is never a binding on its own. */
export function isModifierKey(key: string): boolean {
	return MODIFIER_KEYS.has(key);
}

/** Turn a keydown into a storable binding, e.g. `"Ctrl+Shift+R"` or `"Space"`. */
export function bindingFromEvent(evt: KeyboardEvent): string {
	const parts: string[] = [];
	if (evt.ctrlKey) parts.push("Ctrl");
	if (evt.metaKey) parts.push("Meta");
	if (evt.shiftKey) parts.push("Shift");
	if (evt.altKey) parts.push("Alt");
	parts.push(KEY_TO_DISPLAY[evt.key] ?? evt.key);
	return parts.join("+");
}

/**
 * Split a binding into the shape `Scope.register` wants.
 *
 * Returns `null` for an empty or malformed binding, which the caller treats as
 * "unbound" rather than as an error — an action with no key is a legitimate
 * choice.
 */
export function parseHotkey(binding: string): ParsedHotkey | null {
	const trimmed = (binding ?? "").trim();
	if (trimmed.length === 0) return null;

	// A trailing "+" means the bound key is literally "+".
	const parts = trimmed.endsWith("+")
		? [...trimmed.slice(0, -1).split("+").filter(Boolean), "+"]
		: trimmed.split("+");

	const key = parts.pop();
	if (!key) return null;

	const modifiers: Modifier[] = [];
	for (const part of parts) {
		const match = MODIFIERS.find((m) => m.toLowerCase() === part.trim().toLowerCase());
		if (!match) return null;
		modifiers.push(match);
	}
	return { modifiers, key: DISPLAY_TO_KEY[key] ?? key };
}

/** How a binding should read in the settings tab and on button labels. */
export function displayHotkey(binding: string): string {
	return (binding ?? "").trim().length === 0 ? "Not set" : binding.trim();
}

/**
 * Actions sharing a binding, keyed by binding.
 *
 * Only conflicts that can actually collide are reported: `reveal` and the
 * grades never both apply at the same moment, but the settings tab has no way
 * to know that, so it reports any duplicate and lets the user judge.
 */
export function findConflicts(hotkeys: Record<ReviewActionId, string>): Map<string, ReviewActionId[]> {
	const seen = new Map<string, ReviewActionId[]>();
	for (const action of REVIEW_ACTIONS) {
		const binding = (hotkeys[action.id] ?? "").trim();
		if (binding.length === 0) continue;
		const key = binding.toLowerCase();
		const list = seen.get(key);
		if (list) list.push(action.id);
		else seen.set(key, [action.id]);
	}
	for (const [key, list] of seen) if (list.length < 2) seen.delete(key);
	return seen;
}

/** Fill in any action missing from stored settings, so a new action is never unbound. */
export function withDefaults(stored: Partial<Record<ReviewActionId, string>> | undefined): Record<ReviewActionId, string> {
	const out = { ...DEFAULT_HOTKEYS };
	if (!stored) return out;
	for (const action of REVIEW_ACTIONS) {
		const value = stored[action.id];
		if (typeof value === "string") out[action.id] = value;
	}
	return out;
}
