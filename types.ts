/**
 * flashcard-core — public contract
 * ================================
 *
 * This file is the entire integration surface for other plugins. It has **no
 * runtime dependencies** (no `obsidian`, no `ts-fsrs`), so a generator plugin
 * can either import it from this plugin's folder or copy it into its own tree.
 *
 * Two integration paths exist and they are equivalent in power:
 *
 *   1. **JSON ingestion** (primary). Emit an {@link IngestSpec} document and
 *      hand it to the core. Serialisable, versioned, safe to write to disk.
 *   2. **Programmatic API** (secondary). Grab {@link FlashcardCoreAPI} off the
 *      loaded plugin instance and call it directly at runtime.
 *
 * @packageDocumentation
 */

/** Version of the {@link IngestSpec} document format understood by this build. */
export const SCHEMA_VERSION = "1.0";

/** Frontmatter marker that identifies a note as a flashcard. Bases filters on this. */
export const CARD_MARKER = "card";

// ---------------------------------------------------------------------------
// Scheduling primitives
// ---------------------------------------------------------------------------

/**
 * A grade submitted by the reviewer.
 *
 * Numerically identical to the FSRS grades, so values can be persisted and
 * passed across plugin boundaries without translation.
 */
export const Rating = {
	Again: 1,
	Hard: 2,
	Good: 3,
	Easy: 4,
} as const;
export type Rating = (typeof Rating)[keyof typeof Rating];

/** Lifecycle state of a card, as written to `fsrs_state` in frontmatter. */
export type CardState = "new" | "learning" | "review" | "relearning";

/**
 * Persisted FSRS state for a single card.
 *
 * **Owned exclusively by flashcard-core.** Generators must never write these
 * fields; the core preserves them across every regeneration.
 */
export interface FsrsState {
	/** ISO-8601 timestamp the card next becomes due. */
	due: string;
	/** Memory stability in days. `0` for a card that has never been reviewed. */
	stability: number;
	/** FSRS difficulty, roughly 1-10. `0` before the first review. */
	difficulty: number;
	/** Total number of grades ever submitted for this card. */
	reps: number;
	/** Number of times the card lapsed (graded Again from `review`). */
	lapses: number;
	/** Current lifecycle state. */
	state: CardState;
	/** ISO-8601 timestamp of the most recent grade, or `null` if never reviewed. */
	last_review: string | null;
	/** Index into the configured (re)learning steps. Internal to the scheduler. */
	learning_steps: number;
	/** Days the card was scheduled for at the last grading. */
	scheduled_days: number;
}

// ---------------------------------------------------------------------------
// Card specification (what a generator emits)
// ---------------------------------------------------------------------------

/** Rendering hint for the review UI. Does not affect scheduling. */
export type CardTemplate = "basic" | "cloze" | "audio" | "visual";

/**
 * Gate applied to a card's *prerequisites* before the card may be introduced.
 *
 * With `min_stability`, every prerequisite must have reached at least that many
 * days of stability. Without it, every prerequisite must merely have left the
 * `new` state.
 */
export interface CardGate {
	/** Minimum `fsrs_stability` (days) each prerequisite must have reached. */
	min_stability?: number;
}

/**
 * Content of a card. `front` and `back` are Markdown and are required; the
 * media fields are file names.
 *
 * **Media resolution:** a bare file name (no `/`) resolves against the card's
 * own deck folder, so `"c5.mp3"` on a `piano/note-reading` card becomes
 * `![[flashcards/piano/note-reading/c5.mp3]]`. A value containing `/` is
 * treated as a vault-relative path and embedded verbatim. Either way the result
 * is a standard Obsidian embed, so it renders in preview, in the review UI,
 * and in Bases card views.
 *
 * Additional string keys are permitted and are rendered under `## Extra`.
 */
export interface CardFields {
	/** Markdown shown before the flip. */
	front: string;
	/** Markdown shown after the flip. */
	back: string;
	/** Image embedded on the front. */
	front_image?: string;
	/** Audio embedded on the front. */
	front_audio?: string;
	/** Image embedded on the back. */
	back_image?: string;
	/** Audio embedded on the back. */
	back_audio?: string;
	/** Markdown shown under `## Extra`, always visible after the flip. */
	extra?: string;
	[key: string]: string | undefined;
}

/** Per-card ingestion behaviour. */
export interface CardOptions {
	/**
	 * When `true` (the default), re-ingesting an existing id rewrites the note
	 * body and generator-owned frontmatter. When `false`, an existing note is
	 * left untouched and only missing notes are created.
	 *
	 * FSRS state is preserved either way.
	 */
	regenerate_on_change?: boolean;
}

/**
 * One card as supplied by a generator plugin.
 *
 * @see IngestSpec for the wrapping document.
 */
export interface CardSpec {
	/**
	 * Stable, deterministic identifier. Must be namespaced by the generating
	 * plugin: `plugin:deck:key`, e.g. `blossom:note-reading:c5-treble`.
	 *
	 * The id is the upsert key. Regenerating a deck with the same ids updates
	 * content and preserves scheduling history; changing an id creates a new
	 * card with a fresh history.
	 */
	id: string;
	/** Slash-delimited hierarchical deck path, e.g. `piano/note-reading`. */
	deck: string;
	/** Rendering hint. Defaults to `"basic"`. */
	template?: CardTemplate;
	/** Obsidian tags written to the note's `tags` frontmatter. */
	tags?: string[];
	/**
	 * Base sort key for new-card introduction, ascending.
	 *
	 * A float, deliberately: emit `1000`, `2000`, `3000` and you can later
	 * insert `1500` without renumbering the deck. Defaults to `0`.
	 */
	new_order?: number;
	/**
	 * Ids of cards that gate this one. The card stays out of the new queue
	 * until every listed id **exists** and satisfies {@link CardSpec.gate}.
	 *
	 * A prerequisite that does not exist blocks the card indefinitely - this is
	 * intentional, so a partially-generated deck never leaks unordered cards.
	 */
	prerequisites?: string[];
	/** Condition each prerequisite must meet. Defaults to "has left `new`". */
	gate?: CardGate;
	/** Card content. */
	fields: CardFields;
	/** Per-card ingestion behaviour. */
	options?: CardOptions;
}

/**
 * The JSON document a generator hands to {@link FlashcardCoreAPI.upsertCards}.
 *
 * ```json
 * {
 *   "schema_version": "1.0",
 *   "source_plugin": "blossom",
 *   "cards": [ ... ]
 * }
 * ```
 */
export interface IngestSpec {
	/** Must be `"1.0"`. Mismatches are rejected with a diagnostic. */
	schema_version: string;
	/** Name of the generating plugin. Written to each note's `source_plugin`. */
	source_plugin: string;
	/** Cards to create or update. */
	cards: CardSpec[];
	/** Document-level ingestion behaviour. */
	options?: IngestOptions;
}

/** Document-level ingestion behaviour. */
export interface IngestOptions {
	/**
	 * Default for {@link CardOptions.regenerate_on_change} when a card does not
	 * specify one. Defaults to `true`.
	 */
	regenerate_on_change?: boolean;
	/**
	 * Decks this document is authoritative for. Any existing card in one of
	 * these decks that belongs to `source_plugin` but is *not* present in
	 * `cards` is deleted.
	 *
	 * Use this for full-deck regeneration. Omit it for incremental updates.
	 */
	prune_decks?: string[];
}

/** Outcome of an ingestion run. */
export interface IngestResult {
	/** Cards whose notes did not previously exist. */
	created: string[];
	/** Cards whose notes were rewritten. */
	updated: string[];
	/** Cards already byte-identical, or that opted out of regeneration. */
	unchanged: string[];
	/** Cards removed by {@link IngestOptions.prune_decks}. */
	pruned: string[];
	/** Per-card rejections. Ingestion is best-effort: valid cards still land. */
	errors: IngestError[];
}

/** A single rejected card, or a document-level problem. */
export interface IngestError {
	/** Card id, or `null` for a document-level error. */
	id: string | null;
	/** Human-readable explanation. */
	message: string;
}

// ---------------------------------------------------------------------------
// Card records (what the core hands back)
// ---------------------------------------------------------------------------

/** A card as it currently exists in the vault. */
export interface CardRecord {
	/** Stable id from the generator (`id`). */
	id: string;
	/** Vault-relative path of the backing note. */
	path: string;
	/** Deck path (`deck`). */
	deck: string;
	/** Generating plugin (`source_plugin`). */
	source_plugin: string;
	/** Rendering hint (`template`). */
	template: CardTemplate;
	/** Tags (`tags`). */
	tags: string[];
	/** Sort key for new-card introduction (`fc_new_order`). */
	new_order: number;
	/** Gating card ids (`fc_prerequisites`). */
	prerequisites: string[];
	/** Prerequisite gate condition (`fc_gate`). */
	gate: CardGate | null;
	/** Current scheduling state. Read-only; grade via {@link FlashcardCoreAPI.reviewCard}. */
	fsrs: FsrsState;
}

/** A card packaged for display, with its body already split into sections. */
export interface CardContent {
	/** Markdown under `## Front`, media embeds included. */
	front: string;
	/** Markdown under `## Back`, media embeds included. */
	back: string;
	/** Markdown under `## Extra`, or `null` when the section is absent. */
	extra: string | null;
}

/** An item in a review session queue. */
export interface QueueItem {
	/** The card to show. */
	card: CardRecord;
	/**
	 * Why the card is in the queue.
	 *
	 * `new` items count against the deck's daily new limit when first graded;
	 * `review` and `learning` items count against `max_reviews_per_day`.
	 */
	reason: "new" | "learning" | "review";
}

/** Result of grading a card. */
export interface ReviewResult {
	/** The card with its updated, already-persisted FSRS state. */
	card: CardRecord;
	/** The grade that was applied. */
	rating: Rating;
	/** State before the grade, for undo or logging. */
	previous: FsrsState;
	/** `true` if this grade introduced the card (it was `new` beforehand). */
	introduced: boolean;
	/** ISO-8601 timestamp the card is next due. */
	due: string;
}

/** Predicted next-due timestamps for each grade, used to label review buttons. */
export type RatingPreview = Record<Rating, { due: string; interval_label: string }>;

// ---------------------------------------------------------------------------
// Deck configuration
// ---------------------------------------------------------------------------

/** FSRS knobs exposed per deck. */
export interface DeckFsrsParams {
	/** Target recall probability, 0-1. Default `0.9`. Lower = fewer reviews. */
	request_retention?: number;
	/** Cap on scheduling interval in days. Default `36500`. */
	maximum_interval?: number;
	/** Interval fuzzing, to spread same-day clumps. Default `true`. */
	enable_fuzz?: boolean;
	/** Short-term (learning-step) scheduling. Default `true`. */
	enable_short_term?: boolean;
	/** Learning steps, e.g. `["1m", "10m"]`. */
	learning_steps?: string[];
	/** Relearning steps, e.g. `["10m"]`. */
	relearning_steps?: string[];
	/** Optional FSRS weight vector. Omit to use the library defaults. */
	w?: number[];
}

/**
 * Configuration for one deck. Every field is optional: an unset field falls
 * back to the parent deck, and ultimately to the global defaults.
 */
export interface DeckConfig {
	/** Maximum cards introduced per day in this deck. */
	new_per_day?: number;
	/** Maximum non-new cards shown per day in this deck. */
	max_reviews_per_day?: number;
	/** When `false`, the deck is skipped by queue building entirely. */
	enabled?: boolean;
	/** Scheduler tuning for this deck. Merged field-by-field with the parent. */
	fsrs_params?: DeckFsrsParams;
	/**
	 * Explicit parent to inherit from, overriding the implicit path parent.
	 *
	 * By default `piano/note-reading` inherits from `piano`; set `inherits` to
	 * borrow limits from an unrelated deck instead.
	 */
	inherits?: string;
}

/** A deck config with every field filled in by inheritance. */
export interface ResolvedDeckConfig {
	/** The deck this was resolved for. */
	deck: string;
	new_per_day: number;
	max_reviews_per_day: number;
	enabled: boolean;
	fsrs_params: DeckFsrsParams & { request_retention: number };
	/** Decks consulted during resolution, nearest first. Useful for debugging. */
	chain: string[];
}

/** Global settings, stored alongside per-deck config in `_decks.json`. */
export interface GlobalDeckSettings {
	/**
	 * Cap on cards introduced per day across *all* decks combined.
	 * `null` disables the global cap.
	 */
	new_per_day_cap: number | null;
	/** Cap on reviews per day across all decks. `null` disables it. */
	reviews_per_day_cap: number | null;
	/**
	 * Hour (0-23, local time) at which the review day rolls over.
	 * Default `4`, matching Anki's convention.
	 */
	day_start_hour: number;
	/** Defaults for decks with no config of their own. */
	defaults: Required<Omit<DeckConfig, "inherits">>;
}

/** On-disk shape of `flashcards/_decks.json`. */
export interface DeckConfigFile {
	version: 1;
	global: GlobalDeckSettings;
	/** Keyed by deck path. */
	decks: Record<string, DeckConfig>;
}

/** Counters for one deck on the current review day. */
export interface DeckDailyStats {
	deck: string;
	/** Cards introduced today. */
	introduced_today: number;
	/** Grades submitted today for non-new cards. */
	reviews_today: number;
	/** `new_per_day` minus introductions, floored at 0 and capped globally. */
	new_remaining: number;
	/** `max_reviews_per_day` minus reviews, floored at 0 and capped globally. */
	reviews_remaining: number;
	/** Cards in the deck subtree, by state. */
	counts: Record<CardState, number>;
	/** Cards currently due, ignoring limits. */
	due_now: number;
}

// ---------------------------------------------------------------------------
// New-card ordering
// ---------------------------------------------------------------------------

/** Everything a provider needs to order a deck's new cards. */
export interface NewCardOrderContext {
	/** The deck the queue is being built for. */
	deck: string;
	/**
	 * Eligible new cards: prerequisite-gated, already filtered to the deck
	 * subtree, pre-sorted by `new_order` ascending.
	 */
	candidates: CardRecord[];
	/**
	 * Every card the core knows about, including cards outside `deck` and cards
	 * already in review. Use this to reason about what the learner has mastered.
	 */
	all_cards: CardRecord[];
	/** How many cards will actually be taken. Returning more is harmless. */
	limit: number;
	/** ISO-8601 timestamp the queue is being built for. */
	now: string;
}

/**
 * A generator-supplied ordering strategy for new cards.
 *
 * A provider only ever *proposes an order*. It cannot introduce a card that
 * failed prerequisite gating, and it cannot raise the daily limit — the core
 * applies both after the provider returns.
 */
export interface NewCardOrderProvider {
	/** Unique id, used for replacement and unregistration. */
	id: string;
	/**
	 * Deck subtree this provider governs. A provider registered for `piano`
	 * also serves `piano/note-reading` unless a more specific provider exists.
	 * Use `""` to govern every deck.
	 */
	deck: string;
	/**
	 * Return card ids in the order they should be introduced.
	 *
	 * Ids not present in `context.candidates` are ignored. Candidates the
	 * provider omits are **not** appended — omitting a card withholds it for
	 * today, which is a supported way to pace a deck.
	 */
	provide(context: NewCardOrderContext): string[] | Promise<string[]>;
}

/** Call to remove a previously registered provider. */
export type Unregister = () => void;

// ---------------------------------------------------------------------------
// The API object
// ---------------------------------------------------------------------------

/** Options for {@link FlashcardCoreAPI.buildQueue}. */
export interface QueueOptions {
	/** Restrict to this deck and its descendants. Omit for all decks. */
	deck?: string;
	/** Hard cap on total queue length. */
	limit?: number;
	/** Skip new cards entirely. */
	no_new?: boolean;
	/** Ignore daily limits. For "cram" sessions; introductions still count. */
	ignore_limits?: boolean;
}

/**
 * The runtime API exposed on the loaded plugin instance.
 *
 * ```ts
 * const core = (app as any).plugins.getPlugin("flashcard-core")?.api as FlashcardCoreAPI;
 * ```
 */
export interface FlashcardCoreAPI {
	/** Schema version this build speaks. Check it before calling. */
	readonly schemaVersion: string;

	// -- ingestion ----------------------------------------------------------

	/**
	 * Create or update cards. Upsert by {@link CardSpec.id}: content is
	 * replaced, FSRS state is preserved. Safe to call on every deck rebuild.
	 */
	upsertCards(spec: IngestSpec): Promise<IngestResult>;

	/** Delete cards by id. Missing ids are ignored. Returns the count removed. */
	deleteCards(ids: string[]): Promise<number>;

	/**
	 * Delete every card in `deck` (and its descendants) belonging to
	 * `sourcePlugin`. Cards from other plugins in the same deck are untouched.
	 */
	deleteByDeck(deck: string, sourcePlugin: string): Promise<number>;

	// -- reading ------------------------------------------------------------

	/** Fetch one card, or `null` if the id is unknown. */
	getCard(id: string): CardRecord | null;

	/** Every card, optionally restricted to a deck subtree. */
	getCards(deck?: string): CardRecord[];

	/**
	 * Cards that are due now, most overdue first. Excludes new cards; respects
	 * `max_reviews_per_day` unless `limit` is given explicitly.
	 */
	getDueCards(deck?: string, limit?: number): CardRecord[];

	/**
	 * The full session queue for a deck: due reviews plus, subject to
	 * eligibility, ordering and daily limits, today's new cards.
	 */
	buildQueue(options?: QueueOptions): Promise<QueueItem[]>;

	/** Read a card's rendered Markdown sections. */
	getCardContent(id: string): Promise<CardContent | null>;

	/** Deck names known to the core, sorted, including intermediate parents. */
	listDecks(): string[];

	/** Today's counters and card counts for a deck subtree. */
	getDeckStats(deck: string): DeckDailyStats;

	// -- reviewing ----------------------------------------------------------

	/**
	 * Grade a card. Runs FSRS, writes the new state to the note's frontmatter,
	 * and updates the daily counters. Throws if the id is unknown.
	 */
	reviewCard(id: string, rating: Rating): Promise<ReviewResult>;

	/** Predicted outcomes for all four grades, without committing any of them. */
	previewRatings(id: string): RatingPreview | null;

	/** Reset a card to `new`, discarding its scheduling history. */
	forgetCard(id: string): Promise<CardRecord>;

	// -- configuration ------------------------------------------------------

	/** Fully resolved config for a deck, following the inheritance chain. */
	getDeckConfig(deck: string): ResolvedDeckConfig;

	/** Raw, unresolved config as stored for exactly this deck. */
	getRawDeckConfig(deck: string): DeckConfig | null;

	/** Merge `partial` into a deck's stored config and persist it. */
	setDeckConfig(deck: string, partial: DeckConfig): Promise<ResolvedDeckConfig>;

	/** Read global caps and defaults. */
	getGlobalSettings(): GlobalDeckSettings;

	/** Merge into global caps and defaults, and persist. */
	setGlobalSettings(partial: Partial<GlobalDeckSettings>): Promise<GlobalDeckSettings>;

	// -- ordering -----------------------------------------------------------

	/**
	 * Install a new-card ordering strategy. Registering a provider with an id
	 * that is already present replaces it.
	 *
	 * @returns a function that removes the provider again — call it in your
	 *          plugin's `onunload`.
	 */
	registerNewCardOrderProvider(provider: NewCardOrderProvider): Unregister;

	// -- UI -----------------------------------------------------------------

	/** Open the review modal for a deck (or all decks when omitted). */
	startReview(deck?: string): Promise<void>;

	/** Fires after every graded card. Returns an unsubscribe function. */
	onReview(handler: (result: ReviewResult) => void): Unregister;
}
