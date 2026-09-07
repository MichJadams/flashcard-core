/**
 * Card-note format: frontmatter keys, body sections, media embeds, and the
 * translation between a note on disk and a {@link CardRecord}.
 *
 * A card note looks like this:
 *
 * ```markdown
 * ---
 * fc: card
 * id: blossom:note-reading:c5-treble
 * deck: piano/note-reading
 * source_plugin: blossom
 * template: audio
 * tags: [treble]
 * fc_new_order: 1420
 * fc_prerequisites: [blossom:note-reading:d5-treble]
 * fc_gate: {min_stability: 5}
 * fsrs_due: 2026-08-24T09:00:00.000Z
 * fsrs_state: review
 * ...
 * ---
 *
 * ## Front
 * What note is this?
 *
 * ![[flashcards/piano/note-reading/treble-c5.png]]
 *
 * ## Back
 * C (third space)
 *
 * ![[flashcards/piano/note-reading/c5.mp3]]
 * ```
 *
 * The `fc` and `deck` properties are the anchors that make the collection
 * queryable from Obsidian Bases; see the README for a ready-made `.base` file.
 */

import { parseYaml, stringifyYaml, type CachedMetadata } from "obsidian";

import type {
	CardContent,
	CardFields,
	CardGate,
	CardRecord,
	CardSpec,
	CardTemplate,
	FsrsState,
} from "../types";
import { CARD_MARKER } from "../types";

// ---------------------------------------------------------------------------
// Frontmatter keys
// ---------------------------------------------------------------------------

/** Keys written by the ingestion layer from a {@link CardSpec}. */
export const GENERATOR_KEYS = [
	"fc",
	"id",
	"deck",
	"source_plugin",
	"template",
	"tags",
	"fc_new_order",
	"fc_prerequisites",
	"fc_gate",
	"fc_hash",
] as const;

/** Keys owned exclusively by the scheduler. Never written by a generator. */
export const FSRS_KEYS = [
	"fsrs_due",
	"fsrs_stability",
	"fsrs_difficulty",
	"fsrs_reps",
	"fsrs_lapses",
	"fsrs_state",
	"fsrs_last_review",
	"fsrs_learning_steps",
	"fsrs_scheduled_days",
] as const;

const VALID_TEMPLATES: CardTemplate[] = ["basic", "cloze", "audio", "visual"];
const VALID_STATES = new Set(["new", "learning", "review", "relearning"]);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type Frontmatter = Record<string, unknown>;

export function asString(v: unknown, fallback: string): string {
	return typeof v === "string" ? v : fallback;
}

export function asNumber(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
	if (typeof v === "string" && v.length > 0) return [v];
	return [];
}

/** `true` when a note's frontmatter marks it as a flashcard with a usable id. */
export function isCardFrontmatter(fm: Frontmatter | undefined): boolean {
	if (!fm) return false;
	return fm["fc"] === CARD_MARKER && typeof fm["id"] === "string" && (fm["id"] as string).length > 0;
}

/** Read the FSRS block, filling in defaults for a card that was never reviewed. */
export function readFsrsState(fm: Frontmatter, fallbackDue: string): FsrsState {
	const rawState = asString(fm["fsrs_state"], "new");
	const lastReview = fm["fsrs_last_review"];
	return {
		due: normaliseDate(fm["fsrs_due"], fallbackDue),
		stability: asNumber(fm["fsrs_stability"], 0),
		difficulty: asNumber(fm["fsrs_difficulty"], 0),
		reps: asNumber(fm["fsrs_reps"], 0),
		lapses: asNumber(fm["fsrs_lapses"], 0),
		state: (VALID_STATES.has(rawState) ? rawState : "new") as FsrsState["state"],
		last_review:
			typeof lastReview === "string" && lastReview.length > 0
				? normaliseDate(lastReview, lastReview)
				: null,
		learning_steps: asNumber(fm["fsrs_learning_steps"], 0),
		scheduled_days: asNumber(fm["fsrs_scheduled_days"], 0),
	};
}

/**
 * Obsidian's YAML parser may hand back a `Date` for an unquoted timestamp, so
 * normalise everything to an ISO string.
 */
function normaliseDate(v: unknown, fallback: string): string {
	if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
	if (typeof v === "string") {
		const parsed = new Date(v);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	return fallback;
}

/** Build a {@link CardRecord} from a note's cached metadata. Returns `null` for non-cards. */
export function recordFromMetadata(path: string, cache: CachedMetadata | null): CardRecord | null {
	const fm = cache?.frontmatter as Frontmatter | undefined;
	if (!isCardFrontmatter(fm)) return null;
	const f = fm as Frontmatter;

	const template = asString(f["template"], "basic") as CardTemplate;
	const gateRaw = f["fc_gate"];
	let gate: CardGate | null = null;
	if (gateRaw && typeof gateRaw === "object" && !Array.isArray(gateRaw)) {
		const min = (gateRaw as Record<string, unknown>)["min_stability"];
		if (typeof min === "number" && Number.isFinite(min)) gate = { min_stability: min };
		else gate = {};
	}

	return {
		id: f["id"] as string,
		path,
		deck: normaliseDeck(asString(f["deck"], "")),
		source_plugin: asString(f["source_plugin"], "unknown"),
		template: VALID_TEMPLATES.includes(template) ? template : "basic",
		tags: asStringArray(f["tags"]),
		new_order: asNumber(f["fc_new_order"], 0),
		prerequisites: asStringArray(f["fc_prerequisites"]),
		gate,
		fsrs: readFsrsState(f, new Date(0).toISOString()),
	};
}

/** Content hash stored in `fc_hash`, used to skip no-op rewrites. */
export function readHash(cache: CachedMetadata | null): string | null {
	const fm = cache?.frontmatter as Frontmatter | undefined;
	const h = fm?.["fc_hash"];
	return typeof h === "string" ? h : null;
}

// ---------------------------------------------------------------------------
// Deck and path helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace and stray slashes: ` /Piano//Note Reading/ ` -> `Piano/Note Reading`. */
export function normaliseDeck(deck: string): string {
	return deck
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.join("/");
}

/**
 * `true` when a card in `deck` belongs to the deck `selector` names.
 *
 * Decks are flat, so this is equality — an id with slashes in it is a name,
 * not a path. An empty selector means "every deck", which is how the review
 * commands and the queue builder express "no deck filter".
 */
export function deckSelects(deck: string, selector: string): boolean {
	const s = normaliseDeck(selector);
	return s === "" || normaliseDeck(deck) === s;
}

const ILLEGAL_PATH_CHARS = /[\\/:*?"<>|#^[\]]/g;

/**
 * Deterministic file name for a card id.
 *
 * `:` becomes `__` so the namespace structure survives, and any other character
 * Obsidian or the filesystem dislikes becomes `-`. The id in frontmatter — not
 * the file name — is authoritative, so a rename never loses a card.
 */
export function fileNameForId(id: string): string {
	let base = id.replace(/:/g, "__").replace(ILLEGAL_PATH_CHARS, "-").replace(/\s+/g, "-").trim();
	base = base.replace(/^\.+/, "").replace(/\.+$/, "");
	if (base.length === 0) base = "card";
	if (base.length > 120) base = `${base.slice(0, 110)}-${shortHash(id)}`;
	return `${base}.md`;
}

/**
 * Fallback folder for a deck with no deck note: `<root>/<id>`.
 *
 * A registered deck's folder comes from its note instead, which is the only
 * thing that keeps cards landing next to their siblings once a deck id stops
 * resembling a path.
 */
export function deckFolder(root: string, deck: string): string {
	const d = normaliseDeck(deck);
	const r = root.replace(/^\/+|\/+$/g, "");
	return d ? `${r}/${d}` : r;
}

/** Full vault path of the note backing a card, given its deck's folder. */
export function cardPath(folder: string, id: string): string {
	return `${folder.replace(/\/+$/, "")}/${fileNameForId(id)}`;
}

/** Short, stable, non-cryptographic digest. Only ever used for change detection. */
export function shortHash(input: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
	}
	const a = (h1 >>> 0).toString(36);
	const b = (h2 >>> 0).toString(36);
	return `${a}${b}`.slice(0, 12);
}

// ---------------------------------------------------------------------------
// Media embeds
// ---------------------------------------------------------------------------

const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|flac|webm|3gp)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i;

/**
 * Turn a media field into a standard Obsidian embed.
 *
 * A bare file name is resolved against the card's own deck folder — media lives
 * alongside the cards that reference it. A value containing `/` is treated as a
 * vault-relative path and used as-is. A value that is already an embed or a
 * Markdown image is passed straight through, so a generator can hand-roll one.
 */
export function mediaEmbed(folder: string, value: string): string {
	const v = value.trim();
	if (v.length === 0) return "";
	if (v.startsWith("![[") || v.startsWith("![")) return v;
	if (v.includes("/")) return `![[${v.replace(/^\/+/, "")}]]`;
	return `![[${folder.replace(/\/+$/, "")}/${v}]]`;
}

/** `true` if the file name looks like audio we should offer to autoplay. */
export function isAudioFile(name: string): boolean {
	return AUDIO_EXT.test(name);
}

/** `true` if the file name looks like an image. */
export function isImageFile(name: string): boolean {
	return IMAGE_EXT.test(name);
}

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------

/** Fields consumed by the fixed sections; everything else falls through to Extra. */
const KNOWN_FIELDS = new Set([
	"front",
	"back",
	"extra",
	"front_image",
	"front_audio",
	"back_image",
	"back_audio",
]);

function section(name: string, parts: (string | undefined)[]): string | null {
	const body = parts
		.map((p) => (p ?? "").trim())
		.filter((p) => p.length > 0)
		.join("\n\n");
	if (body.length === 0 && name !== "Front" && name !== "Back") return null;
	return `## ${name}\n\n${body}`;
}

/** Render the Markdown body of a card note from its fields. */
export function renderBody(folder: string, fields: CardFields): string {
	const embed = (v: string | undefined) => (v ? mediaEmbed(folder, v) : undefined);

	const extras: string[] = [];
	if (fields.extra) extras.push(fields.extra);
	for (const [key, value] of Object.entries(fields)) {
		if (KNOWN_FIELDS.has(key) || typeof value !== "string" || value.trim().length === 0) continue;
		extras.push(`**${key}:** ${value}`);
	}

	const blocks = [
		section("Front", [fields.front, embed(fields.front_image), embed(fields.front_audio)]),
		section("Back", [fields.back, embed(fields.back_image), embed(fields.back_audio)]),
		extras.length > 0 ? section("Extra", extras) : null,
	].filter((b): b is string => b !== null);

	return `${blocks.join("\n\n")}\n`;
}

/**
 * Split a note body back into its sections.
 *
 * Tolerant by design: a hand-written note with different heading casing, or
 * with no headings at all, still yields something reviewable rather than
 * throwing. A body with no `## Front` is treated as all-front.
 */
export function parseBody(body: string): CardContent {
	const lines = body.split(/\r?\n/);
	const sections: Record<string, string[]> = {};
	let current: string | null = null;

	for (const line of lines) {
		const heading = /^##\s+(front|back|extra)\s*$/i.exec(line.trim());
		if (heading) {
			current = heading[1].toLowerCase();
			sections[current] = [];
			continue;
		}
		if (current) sections[current].push(line);
	}

	const take = (name: string): string => (sections[name] ?? []).join("\n").trim();

	if (!("front" in sections) && !("back" in sections)) {
		return { front: body.trim(), back: "", extra: null };
	}
	const extra = take("extra");
	return { front: take("front"), back: take("back"), extra: extra.length > 0 ? extra : null };
}

/** Split raw file content into its frontmatter block and the body after it. */
export function splitNote(content: string): { frontmatter: Frontmatter; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	if (!match) return { frontmatter: {}, body: content };
	let frontmatter: Frontmatter = {};
	try {
		const parsed = parseYaml(match[1]);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			frontmatter = parsed as Frontmatter;
		}
	} catch {
		// A malformed block is treated as empty; the rewrite below repairs it.
	}
	return { frontmatter, body: content.slice(match[0].length) };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Serialise state back into the `fsrs_*` frontmatter keys. */
export function fsrsFrontmatter(state: FsrsState): Frontmatter {
	return {
		fsrs_due: state.due,
		fsrs_stability: state.stability,
		fsrs_difficulty: state.difficulty,
		fsrs_reps: state.reps,
		fsrs_lapses: state.lapses,
		fsrs_state: state.state,
		fsrs_last_review: state.last_review,
		fsrs_learning_steps: state.learning_steps,
		fsrs_scheduled_days: state.scheduled_days,
	};
}

/** The generator-owned frontmatter keys for a spec, minus the content hash. */
export function generatorFrontmatter(spec: CardSpec, sourcePlugin: string): Frontmatter {
	const fm: Frontmatter = {
		fc: CARD_MARKER,
		id: spec.id,
		deck: normaliseDeck(spec.deck),
		source_plugin: sourcePlugin,
		template: spec.template ?? "basic",
		tags: spec.tags ?? [],
		fc_new_order: spec.new_order ?? 0,
		fc_prerequisites: spec.prerequisites ?? [],
	};
	if (spec.gate && typeof spec.gate.min_stability === "number") {
		fm["fc_gate"] = { min_stability: spec.gate.min_stability };
	}
	return fm;
}

/**
 * Compose the full text of a card note.
 *
 * Key order is deliberate and stable — marker and deck first so the file reads
 * well and diffs cleanly — and unknown keys the user added by hand are carried
 * through untouched at the end.
 */
export function composeNote(
	generator: Frontmatter,
	fsrs: FsrsState,
	preserved: Frontmatter,
	body: string,
	hash: string,
): string {
	const ordered: Frontmatter = {};
	for (const key of GENERATOR_KEYS) {
		if (key === "fc_hash") continue;
		if (key in generator) ordered[key] = generator[key];
	}
	ordered["fc_hash"] = hash;
	Object.assign(ordered, fsrsFrontmatter(fsrs));
	for (const [key, value] of Object.entries(preserved)) {
		if (key in ordered) continue;
		ordered[key] = value;
	}
	return `---\n${stringifyYaml(ordered)}---\n\n${body.trimStart()}`;
}

/** Frontmatter keys that neither the generator nor the scheduler owns. */
export function preservedKeys(fm: Frontmatter): Frontmatter {
	const owned = new Set<string>([...GENERATOR_KEYS, ...FSRS_KEYS]);
	const out: Frontmatter = {};
	for (const [key, value] of Object.entries(fm)) {
		if (!owned.has(key)) out[key] = value;
	}
	return out;
}

/** Hash of everything ingestion controls, so an unchanged spec is a no-op write. */
export function contentHash(generator: Frontmatter, body: string): string {
	return shortHash(JSON.stringify(generator) + " " + body);
}
