/**
 * The card index and all vault I/O for card notes.
 *
 * Cards are discovered from Obsidian's metadata cache rather than from a
 * sidecar database: any note with `fc: card` and an `id` is a card, wherever it
 * lives. That keeps the collection inspectable, hand-editable in an emergency,
 * and — crucially — queryable from Bases without this plugin's involvement.
 */

import {
	normalizePath,
	TFile,
	TFolder,
	type App,
	type CachedMetadata,
	type EventRef,
} from "obsidian";

import type { CardContent, CardRecord, CardSpec, FsrsState } from "../types";
import {
	cardPath,
	composeNote,
	contentHash,
	deckFolder,
	deckSelects,
	fsrsFrontmatter,
	generatorFrontmatter,
	isCardFrontmatter,
	normaliseDeck,
	parseBody,
	preservedKeys,
	readHash,
	recordFromMetadata,
	renderBody,
	splitNote,
} from "./note";

/** What happened to a note during an upsert. */
export type WriteOutcome = "created" | "updated" | "unchanged";

/**
 * In-memory index of every card note in the vault, kept in sync with the
 * metadata cache.
 */
export class CardStore {
	private byId = new Map<string, CardRecord>();
	private byPath = new Map<string, string>();
	private listeners = new Set<() => void>();
	private refs: EventRef[] = [];
	private ready = false;

	constructor(
		private app: App,
		private root: string,
		/**
		 * A registered deck's own folder, or `null` when it has no deck note.
		 *
		 * Injected rather than derived: once a deck id is an opaque name, the
		 * only thing that knows where its cards belong is its deck note. Without
		 * this, regenerating a deck would scatter its cards into `<root>/<id>`.
		 */
		private folderForDeck: (deck: string) => string | null = () => null,
	) {}

	/** Change the fallback folder for decks with no note. Moves nothing. */
	setRoot(root: string): void {
		this.root = root;
	}

	/** Where this deck's cards and media belong. */
	private folderFor(deck: string): string {
		return this.folderForDeck(deck) ?? deckFolder(this.root, deck);
	}

	/** Perform the initial scan and start watching for changes. */
	start(): void {
		this.rebuild();
		this.ready = true;

		this.refs.push(
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				this.indexFile(file, cache);
				this.notify();
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
				this.forgetPath(oldPath);
				if (file instanceof TFile) {
					this.indexFile(file, this.app.metadataCache.getFileCache(file));
				}
				this.notify();
			}),
		);
	}

	/** Detach every vault listener. */
	stop(): void {
		for (const ref of this.refs) this.app.metadataCache.offref(ref);
		this.refs = [];
		this.listeners.clear();
	}

	/** Subscribe to index changes. Returns an unsubscribe function. */
	onChange(handler: () => void): () => void {
		this.listeners.add(handler);
		return () => this.listeners.delete(handler);
	}

	private notify(): void {
		if (!this.ready) return;
		for (const handler of this.listeners) handler();
	}

	// -- indexing -----------------------------------------------------------

	/** Full rescan. Cheap enough for tens of thousands of notes. */
	rebuild(): void {
		this.byId.clear();
		this.byPath.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			this.indexFile(file, this.app.metadataCache.getFileCache(file));
		}
	}

	private indexFile(file: TFile, cache: CachedMetadata | null): void {
		this.forgetPath(file.path);
		if (file.extension !== "md") return;
		if (!isCardFrontmatter(cache?.frontmatter)) return;
		const record = recordFromMetadata(file.path, cache);
		if (!record) return;

		const existing = this.byId.get(record.id);
		if (existing && existing.path !== record.path) {
			// Two notes claim the same id — most often a copy-paste. Keep the
			// first by path order so the choice is stable across restarts.
			if (existing.path < record.path) return;
			this.byPath.delete(existing.path);
		}
		this.byId.set(record.id, record);
		this.byPath.set(record.path, record.id);
	}

	private forgetPath(path: string): boolean {
		const id = this.byPath.get(path);
		if (id === undefined) return false;
		this.byPath.delete(path);
		const record = this.byId.get(id);
		if (record && record.path === path) this.byId.delete(id);
		return true;
	}

	// -- reading ------------------------------------------------------------

	/** One card, or `null` if the id is unknown. */
	get(id: string): CardRecord | null {
		return this.byId.get(id) ?? null;
	}

	/** The card backed by a note path, or `null` if the note is not a card. */
	getByPath(path: string): CardRecord | null {
		const id = this.byPath.get(path);
		return id === undefined ? null : (this.byId.get(id) ?? null);
	}

	/** Every indexed card. */
	all(): CardRecord[] {
		return [...this.byId.values()];
	}

	/** Cards in a deck. An omitted deck means every card. */
	inDeck(deck?: string): CardRecord[] {
		if (deck === undefined || normaliseDeck(deck) === "") return this.all();
		return this.all().filter((c) => deckSelects(c.deck, deck));
	}

	/** Every deck id that has at least one card. */
	decks(): string[] {
		const set = new Set<string>();
		for (const card of this.byId.values()) {
			if (card.deck !== "") set.add(card.deck);
		}
		return [...set].sort();
	}

	/** Read and split a card's body. */
	async content(id: string): Promise<CardContent | null> {
		const record = this.byId.get(id);
		if (!record) return null;
		const file = this.app.vault.getAbstractFileByPath(record.path);
		if (!(file instanceof TFile)) return null;
		const raw = await this.app.vault.cachedRead(file);
		return parseBody(splitNote(raw).body);
	}

	// -- writing ------------------------------------------------------------

	/**
	 * Create or update the note for a card spec.
	 *
	 * Upsert semantics, and the single most important invariant in the plugin:
	 * an existing card keeps every `fsrs_*` field it already had. Generators
	 * regenerate decks constantly, and a regeneration must never cost the
	 * learner their review history.
	 */
	async upsert(
		spec: CardSpec,
		sourcePlugin: string,
		regenerate: boolean,
		freshState: () => FsrsState,
	): Promise<WriteOutcome> {
		const deck = normaliseDeck(spec.deck);
		const generator = generatorFrontmatter(spec, sourcePlugin);
		const folder = this.folderFor(deck);
		const body = renderBody(folder, spec.fields);
		const hash = contentHash(generator, body);

		const existing = this.byId.get(spec.id);
		const file = existing ? this.app.vault.getAbstractFileByPath(existing.path) : null;

		if (existing && file instanceof TFile) {
			if (!regenerate) return "unchanged";
			const cache = this.app.metadataCache.getFileCache(file);
			if (readHash(cache) === hash && existing.deck === deck) return "unchanged";

			const raw = await this.app.vault.read(file);
			const split = splitNote(raw);
			const state = existing.fsrs;
			const next = composeNote(generator, state, preservedKeys(split.frontmatter), body, hash);
			if (next !== raw) await this.app.vault.modify(file, next);

			// A deck change means the note belongs in a different folder.
			const desired = normalizePath(cardPath(folder, spec.id));
			if (desired !== file.path) {
				await this.ensureFolder(folder);
				await this.app.fileManager.renameFile(file, desired).catch(() => undefined);
			}
			this.indexFile(file, this.app.metadataCache.getFileCache(file));
			return "updated";
		}

		const path = normalizePath(cardPath(folder, spec.id));
		const atPath = this.app.vault.getAbstractFileByPath(path);
		if (atPath instanceof TFile) {
			// A note already occupies the path but was not indexed as this card —
			// adopt it rather than clobbering an unrelated file's history.
			const raw = await this.app.vault.read(atPath);
			const split = splitNote(raw);
			const state = this.stateFrom(atPath, freshState);
			await this.app.vault.modify(
				atPath,
				composeNote(generator, state, preservedKeys(split.frontmatter), body, hash),
			);
			this.indexFile(atPath, this.app.metadataCache.getFileCache(atPath));
			return "updated";
		}

		await this.ensureFolder(folder);
		const created = await this.app.vault.create(
			path,
			composeNote(generator, freshState(), {}, body, hash),
		);
		this.indexFile(created, this.app.metadataCache.getFileCache(created));
		return "created";
	}

	/**
	 * Scheduling state already present in a note, or a fresh state if it has
	 * none. Used when adopting a note that occupies a card path, so an existing
	 * review history is inherited rather than discarded.
	 */
	private stateFrom(file: TFile, fallback: () => FsrsState): FsrsState {
		const record = recordFromMetadata(file.path, this.app.metadataCache.getFileCache(file));
		return record ? record.fsrs : fallback();
	}

	/**
	 * Write new scheduling state to a card's frontmatter.
	 *
	 * Uses `processFrontMatter` so the body — which may have been edited by
	 * hand since the last generation — is left completely alone.
	 */
	async writeState(id: string, state: FsrsState): Promise<CardRecord | null> {
		const record = this.byId.get(id);
		if (!record) return null;
		const file = this.app.vault.getAbstractFileByPath(record.path);
		if (!(file instanceof TFile)) return null;

		await this.app.fileManager.processFrontMatter(file, (fm) => {
			Object.assign(fm, fsrsFrontmatter(state));
		});

		const updated: CardRecord = { ...record, fsrs: state };
		this.byId.set(id, updated);
		return updated;
	}

	/** Delete card notes by id. Returns how many were actually removed. */
	async remove(ids: string[]): Promise<number> {
		let removed = 0;
		for (const id of ids) {
			const record = this.byId.get(id);
			if (!record) continue;
			const file = this.app.vault.getAbstractFileByPath(record.path);
			if (file instanceof TFile) {
				await this.app.fileManager.trashFile(file);
				removed += 1;
			}
			this.forgetPath(record.path);
		}
		if (removed > 0) this.notify();
		return removed;
	}

	/** Create a folder and every missing parent above it. */
	private async ensureFolder(folder: string): Promise<void> {
		const path = normalizePath(folder);
		if (path === "" || path === "/") return;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;

		const parts = path.split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (this.app.vault.getAbstractFileByPath(current) instanceof TFolder) continue;
			await this.app.vault.createFolder(current).catch(() => undefined);
		}
	}
}
