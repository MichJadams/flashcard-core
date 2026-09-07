/**
 * Deck discovery and configuration.
 *
 * A deck is a folder holding a `flashcard-core-deck.md` note, and that note's
 * frontmatter *is* the deck's config. Two things follow from putting it there
 * rather than in a JSON file:
 *
 *   - Config is editable in Obsidian itself, next to the cards it governs,
 *     instead of in a file the app cannot even open.
 *   - The deck's `id` is what cards point at — never its folder path — so a
 *     deck folder can be renamed or moved without rewriting a single card.
 *
 * Decks are flat. There is no inheritance: a field the deck note leaves unset
 * falls back to the global defaults and nowhere else.
 */

import { TFile, normalizePath, type App, type CachedMetadata, type EventRef } from "obsidian";

import {
	DECK_FILE,
	DECK_MARKER,
	type DeckConfig,
	type DeckFsrsParams,
	type DeckNote,
	type GlobalDeckSettings,
	type ResolvedDeckConfig,
} from "../types";
import { asNumber, asString, normaliseDeck } from "./note";

/** Shipped defaults, used until the user edits them in settings. */
export const DEFAULT_GLOBAL: GlobalDeckSettings = {
	new_per_day_cap: null,
	reviews_per_day_cap: null,
	day_start_hour: 4,
	defaults: {
		new_per_day: 20,
		max_reviews_per_day: 200,
		enabled: true,
		fsrs_params: { request_retention: 0.9 },
	},
};

/**
 * Where a deck's note should go, guessed from where its cards already are.
 *
 * The most common folder wins rather than the first, so one stray card filed
 * somewhere odd cannot drag the deck note along with it. `null` when there are
 * no cards to learn from.
 */
export function folderForCards(paths: string[]): string | null {
	const counts = new Map<string, number>();
	for (const path of paths) {
		const folder = path.split("/").slice(0, -1).join("/");
		counts.set(folder, (counts.get(folder) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestCount = 0;
	for (const [folder, count] of counts) {
		if (count > bestCount) {
			best = folder;
			bestCount = count;
		}
	}
	return best;
}

/** `true` for a note whose frontmatter marks it as a deck. */
export function isDeckFrontmatter(fm: Record<string, unknown> | undefined): boolean {
	if (!fm) return false;
	return fm["fc"] === DECK_MARKER && typeof fm["id"] === "string" && (fm["id"] as string).length > 0;
}

/**
 * Read a deck note's frontmatter into a {@link DeckNote}.
 *
 * Absent and malformed are treated the same and simply leave the field unset,
 * so a typo in one field cannot cost the deck its whole config.
 */
export function deckFromMetadata(path: string, cache: CachedMetadata | null): DeckNote | null {
	const fm = cache?.frontmatter as Record<string, unknown> | undefined;
	if (!isDeckFrontmatter(fm)) return null;
	const f = fm as Record<string, unknown>;

	const id = normaliseDeck(f["id"] as string);
	if (id === "") return null;

	const note: DeckNote = {
		id,
		path,
		folder: path.split("/").slice(0, -1).join("/"),
	};

	const name = asString(f["name"], "").trim();
	if (name !== "") note.name = name;
	if (typeof f["new_per_day"] === "number") note.new_per_day = f["new_per_day"];
	if (typeof f["max_reviews_per_day"] === "number") {
		note.max_reviews_per_day = f["max_reviews_per_day"];
	}
	if (typeof f["enabled"] === "boolean") note.enabled = f["enabled"];

	const fsrs = readFsrsParams(f["fsrs_params"]);
	if (fsrs) note.fsrs_params = fsrs;

	return note;
}

/** Pick the FSRS fields we understand out of a frontmatter value. */
function readFsrsParams(raw: unknown): DeckFsrsParams | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const src = raw as Record<string, unknown>;
	const out: DeckFsrsParams = {};
	if (typeof src["request_retention"] === "number") {
		out.request_retention = src["request_retention"];
	}
	if (typeof src["maximum_interval"] === "number") out.maximum_interval = src["maximum_interval"];
	if (typeof src["enable_fuzz"] === "boolean") out.enable_fuzz = src["enable_fuzz"];
	if (typeof src["enable_short_term"] === "boolean") {
		out.enable_short_term = src["enable_short_term"];
	}
	const steps = (key: "learning_steps" | "relearning_steps") => {
		const v = src[key];
		if (Array.isArray(v)) out[key] = v.filter((s): s is string => typeof s === "string");
	};
	steps("learning_steps");
	steps("relearning_steps");
	const w = src["w"];
	if (Array.isArray(w)) out.w = w.filter((n): n is number => typeof n === "number");
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * In-memory index of every deck note in the vault, kept in sync with the
 * metadata cache. Global settings live in the plugin's `data.json` and are
 * reached through the callbacks supplied by the plugin.
 */
export class DeckNoteStore {
	private notes = new Map<string, DeckNote>();
	private pathToId = new Map<string, string>();
	private resolved = new Map<string, ResolvedDeckConfig>();
	private listeners = new Set<() => void>();
	private refs: EventRef[] = [];
	private ready = false;

	constructor(
		private app: App,
		private readGlobal: () => GlobalDeckSettings,
		private writeGlobal: (next: GlobalDeckSettings) => Promise<void>,
	) {}

	/** Initial scan, then watch for changes. */
	start(): void {
		this.rebuild();
		this.ready = true;

		this.refs.push(
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				if (this.indexFile(file, cache)) this.notify();
			}),
		);
		this.refs.push(
			this.app.metadataCache.on("deleted", (file) => {
				if (this.forgetPath(file.path)) this.notify();
			}),
		);
		this.refs.push(
			this.app.vault.on("delete", (file) => {
				if (this.forgetPath(file.path)) this.notify();
			}),
		);
		this.refs.push(
			this.app.vault.on("rename", (file, oldPath) => {
				let changed = this.forgetPath(oldPath);
				if (file instanceof TFile) {
					changed = this.indexFile(file, this.app.metadataCache.getFileCache(file)) || changed;
				}
				if (changed) this.notify();
			}),
		);
	}

	stop(): void {
		for (const ref of this.refs) this.app.metadataCache.offref(ref);
		this.refs = [];
		this.listeners.clear();
	}

	/** Subscribe to deck-config changes. Returns an unsubscribe function. */
	onChange(handler: () => void): () => void {
		this.listeners.add(handler);
		return () => this.listeners.delete(handler);
	}

	private notify(): void {
		this.resolved.clear();
		if (!this.ready) return;
		for (const handler of this.listeners) handler();
	}

	/** Full rescan. */
	rebuild(): void {
		this.notes.clear();
		this.pathToId.clear();
		this.resolved.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			this.indexFile(file, this.app.metadataCache.getFileCache(file));
		}
	}

	/** Index one file. Returns `true` when the deck index actually changed. */
	private indexFile(file: TFile, cache: CachedMetadata | null): boolean {
		const had = this.forgetPath(file.path);
		if (file.extension !== "md") return had;
		const note = deckFromMetadata(file.path, cache);
		if (!note) return had;

		// Two notes claiming one id is a copy-paste. Keep the first by path so
		// the winner does not depend on scan order.
		const existing = this.notes.get(note.id);
		if (existing && existing.path < note.path) return had;

		if (existing) this.pathToId.delete(existing.path);
		this.notes.set(note.id, note);
		this.pathToId.set(note.path, note.id);
		this.resolved.delete(note.id);
		return true;
	}

	private forgetPath(path: string): boolean {
		const id = this.pathToId.get(path);
		if (id === undefined) return false;
		this.pathToId.delete(path);
		this.notes.delete(id);
		this.resolved.delete(id);
		return true;
	}

	/** Every discovered deck note, sorted by id. */
	all(): DeckNote[] {
		return [...this.notes.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	/** The deck note for an id, or `null` when the deck has none. */
	raw(deck: string): DeckNote | null {
		return this.notes.get(normaliseDeck(deck)) ?? null;
	}

	/** Ids of decks that have a deck note, sorted. */
	configuredDecks(): string[] {
		return [...this.notes.keys()].sort();
	}

	/**
	 * Resolve a deck reference a human wrote — an id, or a deck note's `name`.
	 *
	 * Opaque ids are good for stability and terrible to type, so anywhere a
	 * person names a deck by hand (a code block) the display name works too.
	 * An unmatched reference is handed back as-is, so a deck that has cards but
	 * no note is still addressable.
	 */
	byRef(ref: string): string {
		const key = normaliseDeck(ref);
		if (key === "" || this.notes.has(key)) return key;

		const wanted = key.toLowerCase();
		for (const note of this.all()) {
			if ((note.name ?? note.id).trim().toLowerCase() === wanted) return note.id;
		}
		return key;
	}

	/** Drop cached resolutions, e.g. after global defaults change. */
	invalidate(): void {
		this.resolved.clear();
	}

	/**
	 * A deck's effective config: its note's fields, with anything unset filled
	 * in from the global defaults. An unknown deck resolves to the defaults and
	 * reports `registered: false` rather than throwing, so cards in a deck whose
	 * note is missing stay reviewable.
	 */
	resolve(deck: string): ResolvedDeckConfig {
		const key = normaliseDeck(deck);
		const cached = this.resolved.get(key);
		if (cached) return cached;

		const defaults = this.readGlobal().defaults;
		const note = this.notes.get(key);

		const result: ResolvedDeckConfig = {
			deck: key,
			name: note?.name ?? key,
			new_per_day: note?.new_per_day ?? defaults.new_per_day,
			max_reviews_per_day: note?.max_reviews_per_day ?? defaults.max_reviews_per_day,
			enabled: note?.enabled ?? defaults.enabled,
			fsrs_params: {
				request_retention: 0.9,
				...defaults.fsrs_params,
				...(note?.fsrs_params ?? {}),
			},
			path: note?.path ?? null,
			folder: note?.folder ?? null,
			registered: note !== undefined,
		};
		this.resolved.set(key, result);
		return result;
	}

	/**
	 * Merge `partial` into a deck note's frontmatter.
	 *
	 * Writing requires a note: config for a deck that does not exist has
	 * nowhere to live, and silently creating one here would let a typo in a
	 * deck id conjure a deck.
	 */
	async set(deck: string, partial: DeckConfig): Promise<ResolvedDeckConfig> {
		const key = normaliseDeck(deck);
		const note = this.notes.get(key);
		if (!note) {
			throw new Error(`no deck note for "${key}" — create one before configuring it`);
		}
		const file = this.app.vault.getAbstractFileByPath(note.path);
		if (!(file instanceof TFile)) {
			throw new Error(`deck note for "${key}" is missing at ${note.path}`);
		}

		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const [k, v] of Object.entries(partial)) {
				// An explicit `undefined` clears the field back to the default.
				if (v === undefined) delete fm[k];
				else if (k === "fsrs_params") {
					fm[k] = { ...((fm[k] as object) ?? {}), ...(v as object) };
				} else fm[k] = v;
			}
		});

		// processFrontMatter fires a metadata change, but not before this
		// resolves — re-read now so the caller sees its own write.
		this.indexFile(file, this.app.metadataCache.getFileCache(file));
		this.resolved.delete(key);
		return this.resolve(key);
	}

	/**
	 * Create `<folder>/flashcard-core-deck.md`. Returns the existing deck note
	 * untouched if the folder already has one.
	 */
	async createNote(folder: string, deck: string, config: DeckConfig = {}): Promise<DeckNote> {
		const key = normaliseDeck(deck);
		if (key === "") throw new Error("a deck needs an id");

		const dir = normalizePath(folder.replace(/\/+$/, ""));
		const path = normalizePath(`${dir}/${DECK_FILE}`);

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const note = deckFromMetadata(path, this.app.metadataCache.getFileCache(existing));
			if (note) return note;
		}

		if (dir !== "" && !this.app.vault.getAbstractFileByPath(dir)) {
			await this.app.vault.createFolder(dir).catch(() => undefined);
		}

		const file = await this.app.vault.create(path, deckNoteTemplate(key, config));
		const note = deckFromMetadata(path, this.app.metadataCache.getFileCache(file));
		if (note) {
			this.notes.set(note.id, note);
			this.pathToId.set(note.path, note.id);
			this.resolved.delete(note.id);
			this.notify();
			return note;
		}
		// The cache had not caught up; describe the note we just wrote.
		return { ...config, id: key, path, folder: dir };
	}

	/** Global caps and defaults. */
	global(): GlobalDeckSettings {
		return this.readGlobal();
	}

	/** Merge into the global block and persist. */
	async setGlobal(partial: Partial<GlobalDeckSettings>): Promise<GlobalDeckSettings> {
		const current = this.readGlobal();
		const next: GlobalDeckSettings = {
			...current,
			...partial,
			defaults: { ...current.defaults, ...(partial.defaults ?? {}) },
		};
		await this.writeGlobal(next);
		this.resolved.clear();
		return next;
	}
}

/**
 * Body of a fresh deck note.
 *
 * The two blocks go in at creation time deliberately: a deck note that opens
 * to its own stats and an editing panel needs no documentation to be usable.
 */
function deckNoteTemplate(id: string, config: DeckConfig): string {
	const fence = "```";
	const name = config.name ?? id;
	const fm: string[] = ["---", "fc: deck", `id: ${id}`, `name: ${name}`];
	if (config.new_per_day !== undefined) fm.push(`new_per_day: ${config.new_per_day}`);
	if (config.max_reviews_per_day !== undefined) {
		fm.push(`max_reviews_per_day: ${config.max_reviews_per_day}`);
	}
	if (config.enabled !== undefined) fm.push(`enabled: ${config.enabled}`);
	fm.push("---");

	return [
		...fm,
		"",
		`# ${name}`,
		"",
		`${fence}flashcard-deck-stats`,
		fence,
		"",
		`${fence}flashcard-deck-settings`,
		fence,
		"",
	].join("\n");
}
