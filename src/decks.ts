/**
 * Deck configuration: one JSON file for the whole collection, with hierarchical
 * inheritance from parent deck to child.
 *
 * Config deliberately does *not* live in card frontmatter. Decks are configured
 * far less often than cards are generated, and a single file keeps a deck's
 * limits from being silently rewritten by the next regeneration.
 */

import type { App } from "obsidian";
import { normalizePath } from "obsidian";

import type {
	DeckConfig,
	DeckConfigFile,
	DeckFsrsParams,
	GlobalDeckSettings,
	ResolvedDeckConfig,
} from "../types";
import { deckParent, normaliseDeck } from "./note";

/** Shipped defaults, used until the user edits `_decks.json`. */
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

function emptyFile(): DeckConfigFile {
	return { version: 1, global: structuredClone(DEFAULT_GLOBAL), decks: {} };
}

/** Depth limit for `inherits` chains, so a config typo cannot hang the queue builder. */
const MAX_CHAIN = 32;

/**
 * Loads, resolves, and persists `<root>/_decks.json`.
 */
export class DeckConfigStore {
	private file: DeckConfigFile = emptyFile();
	private resolved = new Map<string, ResolvedDeckConfig>();
	private path: string;

	constructor(
		private app: App,
		root: string,
	) {
		this.path = normalizePath(`${root.replace(/\/+$/, "")}/_decks.json`);
	}

	/** Path of the backing JSON file, for display in settings. */
	get filePath(): string {
		return this.path;
	}

	/** Point the store at a new root folder and reload. */
	async relocate(root: string): Promise<void> {
		this.path = normalizePath(`${root.replace(/\/+$/, "")}/_decks.json`);
		await this.load();
	}

	/** Read the file from disk, tolerating absence and corruption. */
	async load(): Promise<void> {
		this.resolved.clear();
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.path))) {
			this.file = emptyFile();
			return;
		}
		try {
			const raw = await adapter.read(this.path);
			const parsed = JSON.parse(raw) as Partial<DeckConfigFile>;
			this.file = {
				version: 1,
				global: { ...structuredClone(DEFAULT_GLOBAL), ...(parsed.global ?? {}) },
				decks: parsed.decks ?? {},
			};
			this.file.global.defaults = {
				...structuredClone(DEFAULT_GLOBAL.defaults),
				...(parsed.global?.defaults ?? {}),
			};
		} catch (err) {
			console.error("[flashcard-core] could not parse deck config, using defaults", err);
			this.file = emptyFile();
		}
	}

	/** Write the file, creating the parent folder if needed. */
	async save(): Promise<void> {
		const folder = this.path.split("/").slice(0, -1).join("/");
		if (folder && !(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder).catch(() => undefined);
		}
		await this.app.vault.adapter.write(this.path, `${JSON.stringify(this.file, null, 2)}\n`);
		this.resolved.clear();
	}

	/** Global caps and defaults. */
	global(): GlobalDeckSettings {
		return this.file.global;
	}

	/** Merge into the global block and persist. */
	async setGlobal(partial: Partial<GlobalDeckSettings>): Promise<GlobalDeckSettings> {
		this.file.global = {
			...this.file.global,
			...partial,
			defaults: { ...this.file.global.defaults, ...(partial.defaults ?? {}) },
		};
		await this.save();
		return this.file.global;
	}

	/** Config stored for exactly this deck, without inheritance. */
	raw(deck: string): DeckConfig | null {
		return this.file.decks[normaliseDeck(deck)] ?? null;
	}

	/** Decks that have an explicit config entry. */
	configuredDecks(): string[] {
		return Object.keys(this.file.decks).sort();
	}

	/** Merge into a deck's stored config and persist. */
	async set(deck: string, partial: DeckConfig): Promise<ResolvedDeckConfig> {
		const key = normaliseDeck(deck);
		const existing = this.file.decks[key] ?? {};
		const merged: DeckConfig = { ...existing, ...partial };
		if (partial.fsrs_params) {
			merged.fsrs_params = { ...(existing.fsrs_params ?? {}), ...partial.fsrs_params };
		}
		// An explicit `undefined` clears a field back to inherited.
		for (const [k, v] of Object.entries(partial)) {
			if (v === undefined) delete (merged as Record<string, unknown>)[k];
		}
		this.file.decks[key] = merged;
		await this.save();
		return this.resolve(key);
	}

	/** Remove a deck's stored config entirely. */
	async clear(deck: string): Promise<void> {
		delete this.file.decks[normaliseDeck(deck)];
		await this.save();
	}

	/**
	 * Resolve a deck's effective config.
	 *
	 * The chain runs from the deck itself, through each ancestor (or the deck
	 * named by `inherits`, when set), to the global defaults. The first entry
	 * that defines a field wins; `fsrs_params` merges field-by-field so a child
	 * can override `request_retention` without restating the learning steps.
	 */
	resolve(deck: string): ResolvedDeckConfig {
		const key = normaliseDeck(deck);
		const cached = this.resolved.get(key);
		if (cached) return cached;

		const chain = this.chainFor(key);
		const defaults = this.file.global.defaults;

		let newPerDay: number | undefined;
		let maxReviews: number | undefined;
		let enabled: boolean | undefined;
		const fsrsParams: DeckFsrsParams = {};

		// Walk furthest ancestor first so nearer entries overwrite.
		for (const step of [...chain].reverse()) {
			const cfg = this.file.decks[step];
			if (!cfg) continue;
			if (typeof cfg.new_per_day === "number") newPerDay = cfg.new_per_day;
			if (typeof cfg.max_reviews_per_day === "number") maxReviews = cfg.max_reviews_per_day;
			if (typeof cfg.enabled === "boolean") enabled = cfg.enabled;
			if (cfg.fsrs_params) Object.assign(fsrsParams, cfg.fsrs_params);
		}

		const result: ResolvedDeckConfig = {
			deck: key,
			new_per_day: newPerDay ?? defaults.new_per_day,
			max_reviews_per_day: maxReviews ?? defaults.max_reviews_per_day,
			enabled: enabled ?? defaults.enabled,
			fsrs_params: {
				request_retention: 0.9,
				...defaults.fsrs_params,
				...fsrsParams,
			},
			chain,
		};
		this.resolved.set(key, result);
		return result;
	}

	/**
	 * The inheritance chain for a deck, nearest first.
	 *
	 * `inherits` short-circuits the implicit path parent. Cycles and runaway
	 * chains are cut off rather than throwing — a bad config should degrade to
	 * the defaults, not break review.
	 */
	private chainFor(deck: string): string[] {
		const chain: string[] = [];
		const seen = new Set<string>();
		let current = deck;

		while (current.length > 0 && chain.length < MAX_CHAIN) {
			if (seen.has(current)) break;
			seen.add(current);
			chain.push(current);
			const explicit = this.file.decks[current]?.inherits;
			current = explicit !== undefined ? normaliseDeck(explicit) : deckParent(current);
		}
		return chain;
	}
}
