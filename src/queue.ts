/**
 * Queue building — three layers, applied strictly in this order.
 *
 *   1. **Eligibility.** A new card is a candidate only if every prerequisite
 *      exists and has cleared the card's gate.
 *   2. **Order.** A registered {@link NewCardOrderProvider} for the deck decides
 *      the order; with no provider, `fc_new_order` ascending.
 *   3. **Limit.** Take as many as the deck's remaining daily budget allows,
 *      rolled up through parent decks and the global cap.
 *
 * The split matters: a provider can reorder freely but can neither smuggle in a
 * gated card nor exceed a limit. Those are the core's to enforce.
 */

import type {
	CardRecord,
	NewCardOrderProvider,
	QueueItem,
	QueueOptions,
	ResolvedDeckConfig,
} from "../types";
import type { DailyLedger } from "./daily";
import type { DeckConfigStore } from "./decks";
import { deckAncestry, deckMatches, normaliseDeck } from "./note";
import type { CardStore } from "./store";

// ---------------------------------------------------------------------------
// Layer 1: eligibility
// ---------------------------------------------------------------------------

/**
 * Can this new card be introduced yet?
 *
 * A missing prerequisite blocks the card. That is deliberate: during a partial
 * generation run it is better to withhold a card than to teach it out of order.
 */
export function isEligible(card: CardRecord, index: Map<string, CardRecord>): boolean {
	if (card.prerequisites.length === 0) return true;
	const minStability = card.gate?.min_stability;

	for (const prereqId of card.prerequisites) {
		const prereq = index.get(prereqId);
		if (!prereq) return false;
		if (typeof minStability === "number") {
			if (prereq.fsrs.stability < minStability) return false;
		} else if (prereq.fsrs.state === "new") {
			return false;
		}
	}
	return true;
}

/** Explain why a card is being withheld. Used by the "why is this card blocked" command. */
export function blockedBy(card: CardRecord, index: Map<string, CardRecord>): string[] {
	const reasons: string[] = [];
	const minStability = card.gate?.min_stability;
	for (const prereqId of card.prerequisites) {
		const prereq = index.get(prereqId);
		if (!prereq) {
			reasons.push(`${prereqId} (does not exist)`);
		} else if (typeof minStability === "number" && prereq.fsrs.stability < minStability) {
			reasons.push(`${prereqId} (stability ${prereq.fsrs.stability} < ${minStability})`);
		} else if (minStability === undefined && prereq.fsrs.state === "new") {
			reasons.push(`${prereqId} (still new)`);
		}
	}
	return reasons;
}

// ---------------------------------------------------------------------------
// Layer 3: budgets
// ---------------------------------------------------------------------------

/**
 * Remaining daily allowances across a deck tree.
 *
 * A card in `piano/note-reading` spends budget in `piano/note-reading`, in
 * `piano`, and in the global pool. Taking it requires every one of those to
 * have room, which is what makes a parent deck's limit actually cap its
 * subtree rather than merely describe it.
 */
export class Budget {
	private perDeck = new Map<string, number>();
	private global: number;

	private constructor(
		private resolve: (deck: string) => ResolvedDeckConfig,
		private spent: (deck: string) => number,
		globalRemaining: number,
	) {
		this.global = globalRemaining;
	}

	/** Budget for introducing new cards. */
	static forNew(decks: DeckConfigStore, ledger: DailyLedger, now: Date): Budget {
		const cap = decks.global().new_per_day_cap;
		const globalRemaining =
			cap === null ? Number.POSITIVE_INFINITY : Math.max(0, cap - ledger.introducedTotal(now));
		return new Budget(
			(deck) => decks.resolve(deck),
			(deck) => ledger.introduced(deck, now),
			globalRemaining,
		);
	}

	/** Budget for showing due reviews. */
	static forReviews(decks: DeckConfigStore, ledger: DailyLedger, now: Date): Budget {
		const cap = decks.global().reviews_per_day_cap;
		const globalRemaining =
			cap === null ? Number.POSITIVE_INFINITY : Math.max(0, cap - ledger.reviewsTotal(now));
		return new Budget(
			(deck) => decks.resolve(deck),
			(deck) => ledger.reviews(deck, now),
			globalRemaining,
		);
	}

	/** A budget with no limits at all, for cram sessions. */
	static unlimited(): Budget {
		return new Budget(
			() => ({}) as ResolvedDeckConfig,
			() => 0,
			Number.POSITIVE_INFINITY,
		);
	}

	private limitFor(deck: string, kind: "new" | "review"): number {
		let remaining = this.perDeck.get(deck);
		if (remaining === undefined) {
			const config = this.resolve(deck);
			const limit =
				kind === "new"
					? (config.new_per_day ?? Number.POSITIVE_INFINITY)
					: (config.max_reviews_per_day ?? Number.POSITIVE_INFINITY);
			remaining = Math.max(0, limit - this.spent(deck));
			this.perDeck.set(deck, remaining);
		}
		return remaining;
	}

	/** How many more cards this deck's subtree may take right now. */
	remaining(deck: string, kind: "new" | "review"): number {
		let least = this.global;
		for (const step of deckAncestry(deck)) least = Math.min(least, this.limitFor(step, kind));
		return least;
	}

	/** Spend one unit against a deck, its ancestors, and the global pool. */
	take(deck: string, kind: "new" | "review"): void {
		for (const step of deckAncestry(deck)) {
			this.perDeck.set(step, Math.max(0, this.limitFor(step, kind) - 1));
		}
		if (Number.isFinite(this.global)) this.global -= 1;
	}
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export interface QueueDeps {
	store: CardStore;
	decks: DeckConfigStore;
	ledger: DailyLedger;
	/** Registered ordering providers, most recently registered last. */
	providers: () => NewCardOrderProvider[];
}

export class QueueBuilder {
	constructor(private deps: QueueDeps) {}

	/** Cards due now, most overdue first, excluding new cards. */
	dueCards(deck?: string, limit?: number, now: Date = new Date()): CardRecord[] {
		const cutoff = now.getTime();
		const due = this.deps.store
			.inDeck(deck)
			.filter((card) => card.fsrs.state !== "new")
			.filter((card) => new Date(card.fsrs.due).getTime() <= cutoff)
			.filter((card) => this.deps.decks.resolve(card.deck).enabled)
			.sort(byDueAscending);

		if (typeof limit === "number") return due.slice(0, Math.max(0, limit));

		const budget = Budget.forReviews(this.deps.decks, this.deps.ledger, now);
		return this.applyBudget(due, budget, "review");
	}

	/**
	 * Build a full session queue: due reviews plus today's new cards, with
	 * learning-step cards first because they are time-sensitive.
	 */
	async build(options: QueueOptions = {}, now: Date = new Date()): Promise<QueueItem[]> {
		const deck = options.deck;
		const ignore = options.ignore_limits === true;

		const reviewBudget = ignore
			? Budget.unlimited()
			: Budget.forReviews(this.deps.decks, this.deps.ledger, now);
		const cutoff = now.getTime();

		const due = this.deps.store
			.inDeck(deck)
			.filter((card) => card.fsrs.state !== "new")
			.filter((card) => new Date(card.fsrs.due).getTime() <= cutoff)
			.filter((card) => this.deps.decks.resolve(card.deck).enabled)
			.sort(byDueAscending);

		const reviews = this.applyBudget(due, reviewBudget, "review").map<QueueItem>((card) => ({
			card,
			reason: card.fsrs.state === "review" ? "review" : "learning",
		}));

		const news = options.no_new === true ? [] : await this.newCards(deck, ignore, now);

		// Learning steps are minutes-scale and go stale fastest; plain reviews
		// next; new cards last so a backlog never crowds out consolidation.
		const ordered = [
			...reviews.filter((i) => i.reason === "learning"),
			...reviews.filter((i) => i.reason === "review"),
			...news,
		];

		return typeof options.limit === "number" ? ordered.slice(0, Math.max(0, options.limit)) : ordered;
	}

	/** Layers 1-3 for new cards. */
	async newCards(deck: string | undefined, ignoreLimits: boolean, now: Date): Promise<QueueItem[]> {
		const all = this.deps.store.all();
		const index = new Map(all.map((card) => [card.id, card]));

		// Layer 1: eligibility.
		const candidates = all
			.filter((card) => card.fsrs.state === "new")
			.filter((card) => deck === undefined || deckMatches(card.deck, deck))
			.filter((card) => this.deps.decks.resolve(card.deck).enabled)
			.filter((card) => isEligible(card, index))
			.sort(byNewOrder);

		if (candidates.length === 0) return [];

		const budget = ignoreLimits
			? Budget.unlimited()
			: Budget.forNew(this.deps.decks, this.deps.ledger, now);

		const target = normaliseDeck(deck ?? "");
		const provider = this.providerFor(target);

		// Layer 2: order.
		let ordered = candidates;
		if (provider) {
			const budgetHint = ignoreLimits ? candidates.length : budget.remaining(target, "new");
			try {
				const ids = await provider.provide({
					deck: target,
					candidates: candidates.map(clone),
					all_cards: all.map(clone),
					limit: Number.isFinite(budgetHint) ? budgetHint : candidates.length,
					now: now.toISOString(),
				});
				ordered = resolveProviderOrder(ids, candidates, provider.id);
			} catch (err) {
				console.error(
					`[flashcard-core] new-card order provider "${provider.id}" threw; ` +
						`falling back to fc_new_order`,
					err,
				);
			}
		}

		// Layer 3: limit.
		return this.applyBudget(ordered, budget, "new").map<QueueItem>((card) => ({
			card,
			reason: "new",
		}));
	}

	/**
	 * The provider governing a deck: the one whose `deck` is the longest prefix
	 * of the target. Ties go to the most recently registered.
	 */
	private providerFor(deck: string): NewCardOrderProvider | null {
		let best: NewCardOrderProvider | null = null;
		let bestLength = -1;
		for (const provider of this.deps.providers()) {
			const scope = normaliseDeck(provider.deck);
			if (!deckMatches(deck, scope)) continue;
			if (scope.length >= bestLength) {
				best = provider;
				bestLength = scope.length;
			}
		}
		return best;
	}

	/** Walk a list, taking each card only while its whole deck chain has room. */
	private applyBudget(cards: CardRecord[], budget: Budget, kind: "new" | "review"): CardRecord[] {
		const taken: CardRecord[] = [];
		for (const card of cards) {
			if (budget.remaining(card.deck, kind) <= 0) continue;
			budget.take(card.deck, kind);
			taken.push(card);
		}
		return taken;
	}
}

/**
 * Map provider-returned ids back to records.
 *
 * Unknown ids are dropped, duplicates collapse to their first occurrence, and
 * candidates the provider omitted are **not** appended — withholding a card is
 * a legitimate pacing decision, so we honour it rather than second-guessing.
 */
export function resolveProviderOrder(
	ids: string[],
	candidates: CardRecord[],
	providerId: string,
): CardRecord[] {
	if (!Array.isArray(ids)) {
		console.error(`[flashcard-core] provider "${providerId}" returned a non-array; ignoring`);
		return candidates;
	}
	const byId = new Map(candidates.map((card) => [card.id, card]));
	const out: CardRecord[] = [];
	const used = new Set<string>();
	for (const id of ids) {
		if (used.has(id)) continue;
		const card = byId.get(id);
		if (!card) continue;
		used.add(id);
		out.push(card);
	}
	return out;
}

function byDueAscending(a: CardRecord, b: CardRecord): number {
	return new Date(a.fsrs.due).getTime() - new Date(b.fsrs.due).getTime();
}

function byNewOrder(a: CardRecord, b: CardRecord): number {
	if (a.new_order !== b.new_order) return a.new_order - b.new_order;
	// Stable tiebreak so a deck with no explicit ordering is at least
	// deterministic across sessions and machines.
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Hand providers a copy, so a misbehaving one cannot mutate the index. */
function clone(card: CardRecord): CardRecord {
	return { ...card, tags: [...card.tags], prerequisites: [...card.prerequisites], fsrs: { ...card.fsrs } };
}
