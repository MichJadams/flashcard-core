/**
 * The runtime API surface, wired to the stores.
 *
 * This class implements {@link FlashcardCoreAPI} exactly; nothing in here is
 * public beyond what `types.ts` declares, so a generator plugin can compile
 * against the interface alone.
 */

import { Notice, type App } from "obsidian";

import type {
	CardContent,
	CardRecord,
	CardState,
	DeckConfig,
	DeckDailyStats,
	DeckNote,
	FlashcardCoreAPI,
	GlobalDeckSettings,
	IngestResult,
	IngestSpec,
	NewCardOrderProvider,
	QueueItem,
	QueueOptions,
	Rating,
	RatingPreview,
	ResolvedDeckConfig,
	ReviewResult,
	Unregister,
} from "../types";
import { SCHEMA_VERSION } from "../types";
import type { DailyLedger } from "./daily";
import type { DeckNoteStore } from "./deck-notes";
import { ingest } from "./ingest";
import { deckSelects, normaliseDeck } from "./note";
import { QueueBuilder } from "./queue";
import type { Scheduler } from "./scheduler";
import type { CardStore } from "./store";

export interface ApiDeps {
	app: App;
	store: CardStore;
	decks: DeckNoteStore;
	ledger: DailyLedger;
	scheduler: Scheduler;
	/** Opens the review modal. Injected so the API layer stays UI-agnostic. */
	openReview: (deck: string | undefined, queue: QueueItem[]) => void;
}

export class FlashcardCore implements FlashcardCoreAPI {
	readonly schemaVersion = SCHEMA_VERSION;

	private providers: NewCardOrderProvider[] = [];
	private reviewHandlers = new Set<(result: ReviewResult) => void>();
	private queue: QueueBuilder;

	constructor(private deps: ApiDeps) {
		this.queue = new QueueBuilder({
			store: deps.store,
			decks: deps.decks,
			ledger: deps.ledger,
			providers: () => this.providers,
		});
	}

	// -- ingestion ----------------------------------------------------------

	async upsertCards(spec: IngestSpec): Promise<IngestResult> {
		return ingest(this.deps.store, spec, () => this.deps.scheduler.newState());
	}

	async deleteCards(ids: string[]): Promise<number> {
		return this.deps.store.remove(ids);
	}

	async deleteByDeck(deck: string, sourcePlugin: string): Promise<number> {
		const ids = this.deps.store
			.all()
			.filter((card) => card.source_plugin === sourcePlugin && deckSelects(card.deck, deck))
			.map((card) => card.id);
		return this.deps.store.remove(ids);
	}

	// -- reading ------------------------------------------------------------

	getCard(id: string): CardRecord | null {
		return this.deps.store.get(id);
	}

	getCards(deck?: string): CardRecord[] {
		return this.deps.store.inDeck(deck);
	}

	getDueCards(deck?: string, limit?: number): CardRecord[] {
		return this.queue.dueCards(deck, limit);
	}

	async buildQueue(options: QueueOptions = {}): Promise<QueueItem[]> {
		return this.queue.build(options);
	}

	async getCardContent(id: string): Promise<CardContent | null> {
		return this.deps.store.content(id);
	}

	listDecks(): string[] {
		const fromCards = this.deps.store.decks();
		const configured = this.deps.decks.configuredDecks();
		return [...new Set([...fromCards, ...configured])].filter((d) => d.length > 0).sort();
	}

	listDeckNotes(): DeckNote[] {
		return this.deps.decks.all();
	}

	resolveDeckRef(ref: string): string {
		return this.deps.decks.byRef(ref);
	}

	getDeckStats(deck: string): DeckDailyStats {
		const key = normaliseDeck(deck);
		const config = this.deps.decks.resolve(key);
		const cards = this.deps.store.inDeck(key);
		const now = Date.now();

		const counts: Record<CardState, number> = { new: 0, learning: 0, review: 0, relearning: 0 };
		let dueNow = 0;
		for (const card of cards) {
			counts[card.fsrs.state] += 1;
			if (card.fsrs.state !== "new" && new Date(card.fsrs.due).getTime() <= now) dueNow += 1;
		}

		const introduced = this.deps.ledger.introduced(key);
		const reviews = this.deps.ledger.reviews(key);
		const global = this.deps.decks.global();
		const newCap =
			global.new_per_day_cap === null
				? Number.POSITIVE_INFINITY
				: Math.max(0, global.new_per_day_cap - this.deps.ledger.introducedTotal());
		const reviewCap =
			global.reviews_per_day_cap === null
				? Number.POSITIVE_INFINITY
				: Math.max(0, global.reviews_per_day_cap - this.deps.ledger.reviewsTotal());

		return {
			deck: key,
			introduced_today: introduced,
			reviews_today: reviews,
			new_remaining: Math.min(Math.max(0, config.new_per_day - introduced), newCap),
			reviews_remaining: Math.min(Math.max(0, config.max_reviews_per_day - reviews), reviewCap),
			counts,
			due_now: dueNow,
		};
	}

	// -- reviewing ----------------------------------------------------------

	/**
	 * Grade a card.
	 *
	 * Introduction accounting happens here and nowhere else: a card counts
	 * against the daily new limit at the moment it is first graded, not when it
	 * enters a queue. A queue the learner abandons costs them nothing.
	 */
	async reviewCard(id: string, rating: Rating): Promise<ReviewResult> {
		const card = this.deps.store.get(id);
		if (!card) throw new Error(`unknown card id "${id}"`);

		const now = new Date();
		const params = this.deps.decks.resolve(card.deck).fsrs_params;
		const previous = card.fsrs;
		const wasNew = previous.state === "new";

		const next = this.deps.scheduler.grade(previous, rating, params, now);
		const updated = await this.deps.store.writeState(id, next);
		if (!updated) throw new Error(`could not write state for "${id}" at ${card.path}`);

		if (wasNew) await this.deps.ledger.recordIntroduction(card.deck, now);
		else await this.deps.ledger.recordReview(card.deck, now);

		const result: ReviewResult = {
			card: updated,
			rating,
			previous,
			introduced: wasNew,
			due: next.due,
		};
		for (const handler of this.reviewHandlers) {
			try {
				handler(result);
			} catch (err) {
				console.error("[flashcard-core] onReview handler threw", err);
			}
		}
		return result;
	}

	previewRatings(id: string): RatingPreview | null {
		const card = this.deps.store.get(id);
		if (!card) return null;
		const params = this.deps.decks.resolve(card.deck).fsrs_params;
		return this.deps.scheduler.preview(card.fsrs, params);
	}

	async forgetCard(id: string): Promise<CardRecord> {
		const card = this.deps.store.get(id);
		if (!card) throw new Error(`unknown card id "${id}"`);
		const params = this.deps.decks.resolve(card.deck).fsrs_params;
		const reset = this.deps.scheduler.forget(card.fsrs, params);
		const updated = await this.deps.store.writeState(id, reset);
		if (!updated) throw new Error(`could not write state for "${id}"`);
		return updated;
	}

	// -- configuration ------------------------------------------------------

	getDeckConfig(deck: string): ResolvedDeckConfig {
		return this.deps.decks.resolve(deck);
	}

	getRawDeckConfig(deck: string): DeckNote | null {
		return this.deps.decks.raw(deck);
	}

	async setDeckConfig(deck: string, partial: DeckConfig): Promise<ResolvedDeckConfig> {
		const resolved = await this.deps.decks.set(deck, partial);
		this.deps.scheduler.invalidate();
		return resolved;
	}

	async createDeckNote(folder: string, deck: string, config: DeckConfig = {}): Promise<DeckNote> {
		const note = await this.deps.decks.createNote(folder, deck, config);
		this.deps.scheduler.invalidate();
		return note;
	}

	getGlobalSettings(): GlobalDeckSettings {
		return this.deps.decks.global();
	}

	async setGlobalSettings(partial: Partial<GlobalDeckSettings>): Promise<GlobalDeckSettings> {
		const global = await this.deps.decks.setGlobal(partial);
		if (typeof partial.day_start_hour === "number") {
			this.deps.ledger.setDayStartHour(partial.day_start_hour);
		}
		this.deps.scheduler.invalidate();
		return global;
	}

	// -- ordering -----------------------------------------------------------

	registerNewCardOrderProvider(provider: NewCardOrderProvider): Unregister {
		if (typeof provider?.provide !== "function" || typeof provider.id !== "string") {
			throw new Error("a new-card order provider needs an `id` and a `provide` function");
		}
		this.providers = this.providers.filter((p) => p.id !== provider.id);
		this.providers.push(provider);
		return () => {
			this.providers = this.providers.filter((p) => p !== provider);
		};
	}

	/** Registered providers, for the diagnostics command. */
	listProviders(): { id: string; deck: string }[] {
		return this.providers.map((p) => ({ id: p.id, deck: p.deck }));
	}

	// -- UI -----------------------------------------------------------------

	async startReview(deck?: string): Promise<void> {
		const queue = await this.buildQueue({ deck });
		if (queue.length === 0) {
			new Notice(
				deck ? `flashcard-core: nothing due in ${deck}.` : "flashcard-core: nothing due right now.",
			);
			return;
		}
		this.deps.openReview(deck, queue);
	}

	onReview(handler: (result: ReviewResult) => void): Unregister {
		this.reviewHandlers.add(handler);
		return () => this.reviewHandlers.delete(handler);
	}
}
