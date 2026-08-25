/**
 * Session pacing — what the learner actually sees, and in what order.
 *
 * {@link QueueBuilder} answers "which cards are allowed today". This module
 * answers the different question of how one sitting is paced, and it is the
 * only place that treats the queue as mutable.
 *
 * Two rules, both aimed at the same failure: meeting fifteen unknown cards in a
 * row, getting none of them, and reaching the end without a single act of
 * recall.
 *
 *   1. **Return after Again.** A card graded Again goes back into the queue a
 *      few cards later instead of being dropped for the rest of the session.
 *      The gap doubles each time, so a card you keep missing is drilled
 *      tightly at first and then given room.
 *   2. **New cards in batches.** Only so many unseen cards are in flight at
 *      once. A held-back card is admitted when one in flight is graded
 *      anything other than Again — which is to say, when you have recalled it
 *      once.
 *
 * Both are pure ordering. Nothing here grades, writes, or schedules: the FSRS
 * state a card carries out of the session is whatever the grades put there,
 * exactly as if the cards had been shown in build order.
 */

import type { CardRecord, QueueItem } from "../types";
import { Rating } from "../types";

/**
 * How many times one card may be sent back within a single session.
 *
 * Past this it leaves, even if still unknown. Its FSRS state is already
 * written, so a learning step brings it back through "check for more" — and a
 * card that has resisted five attempts in three minutes is telling you it
 * needs rewriting, not another look.
 */
export const MAX_SESSION_RETRIES = 4;

export interface SessionConfig {
	/**
	 * Cards to put between a card graded Again and its return, doubling per
	 * retry. `0` disables the return entirely (the queue then runs straight
	 * through, as it did before this existed).
	 */
	againGap: number;
	/**
	 * How many unseen cards may be in flight at once. `0` means no batching:
	 * every new card the daily limit allows is in the session from the start.
	 */
	newBatchSize: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
	againGap: 3,
	newBatchSize: 5,
};

/** A queue item plus what this session knows about it. */
export interface SessionEntry {
	item: QueueItem;
	/** Times this card has come back after Again in this session. 0 on first sight. */
	retries: number;
}

export class SessionQueue {
	/** Cards admitted to the session. Index 0 is on screen. */
	private live: SessionEntry[] = [];
	/** New cards waiting for a batch slot, in queue order. */
	private held: QueueItem[] = [];

	private readonly gap: number;
	private readonly batch: number;

	/** Distinct cards that have left the session, for progress. */
	private done = 0;

	constructor(queue: QueueItem[], config: SessionConfig = DEFAULT_SESSION_CONFIG) {
		this.gap = Math.max(0, Math.floor(config.againGap) || 0);
		this.batch = batchLimit(config.newBatchSize);

		let admitted = 0;
		for (const item of queue) {
			if (item.reason !== "new") {
				this.live.push({ item, retries: 0 });
				continue;
			}
			if (admitted >= this.batch) {
				this.held.push(item);
				continue;
			}
			admitted += 1;
			this.live.push({ item, retries: 0 });
		}
	}

	/** The card on screen, or `null` when the session is finished. */
	get current(): SessionEntry | null {
		return this.live[0] ?? null;
	}

	/** Cards still to be shown, counting the one on screen and the held batch. */
	get remaining(): number {
		return this.live.length + this.held.length;
	}

	/** Distinct cards in this session, shown or not. */
	get size(): number {
		return this.done + this.remaining;
	}

	/** New cards not yet admitted. Exposed for the progress line. */
	get heldBack(): number {
		return this.held.length;
	}

	/**
	 * Record a grade against the card on screen and move on.
	 *
	 * `updated` is the record the grade produced. Passing it keeps a returning
	 * card's state honest — its interval labels and `reps` count would
	 * otherwise be the ones it had before you missed it.
	 */
	graded(rating: Rating, updated?: CardRecord | null): void {
		const entry = this.live.shift();
		if (!entry) return;
		if (updated) entry.item = { ...entry.item, card: updated };

		if (rating === Rating.Again && this.gap > 0 && entry.retries < MAX_SESSION_RETRIES) {
			entry.retries += 1;
			this.reinsert(entry);
			return;
		}
		this.retire(entry);
	}

	/**
	 * Drop the card on screen without grading it.
	 *
	 * Covers both the skip key and a card whose note cannot be read. Neither
	 * has told us anything about recall, so the card leaves rather than
	 * returning — and it frees its batch slot, or a session of skips would sit
	 * there holding cards back for nothing.
	 */
	drop(): void {
		const entry = this.live.shift();
		if (entry) this.retire(entry);
	}

	/** Place a returning card, never on screen again immediately unless it is the last one. */
	private reinsert(entry: SessionEntry): void {
		// 3, 6, 12, 24 with the default gap. Clamped to the queue, so a short
		// session puts the card at the back rather than pretending to a
		// distance it does not have.
		const distance = this.gap * 2 ** (entry.retries - 1);
		const position = Math.min(Math.max(1, distance), this.live.length);
		this.live.splice(position, 0, entry);
	}

	/** A card leaves the session; if it held a batch slot, the next new card takes it. */
	private retire(entry: SessionEntry): void {
		this.done += 1;
		if (entry.item.reason !== "new") return;
		const next = this.held.shift();
		if (next) this.live.push({ item: next, retries: 0 });
	}
}

/** `0`, a negative, or a non-number all mean "no batching". */
function batchLimit(size: number): number {
	if (!Number.isFinite(size)) return Number.POSITIVE_INFINITY;
	const n = Math.floor(size);
	return n > 0 ? n : Number.POSITIVE_INFINITY;
}
