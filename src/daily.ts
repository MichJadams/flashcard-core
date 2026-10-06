/**
 * Daily introduction and review accounting.
 *
 * The core owns this, not the generators. A generator proposes an order; only
 * this module decides what has been spent against a limit today.
 *
 * Decks are flat, so a counter belongs to exactly one deck. The two `*_total`
 * fields exist because the global caps are their own budget, not a sum anyone
 * has to recompute.
 */

import { normaliseDeck } from "./note";

/** Persisted counters for a single review day. */
export interface DailyRecord {
	/** Review day key, `YYYY-MM-DD`, adjusted for `day_start_hour`. */
	day: string;
	/** Cards introduced today, keyed by deck id. */
	introduced: Record<string, number>;
	/** Non-new grades submitted today, keyed by deck id. */
	reviews: Record<string, number>;
	/** Introductions across every deck, for the global cap. */
	introduced_total: number;
	/** Reviews across every deck, for the global cap. */
	reviews_total: number;
}

export function emptyDaily(day: string): DailyRecord {
	return { day, introduced: {}, reviews: {}, introduced_total: 0, reviews_total: 0 };
}

/**
 * The review-day key for an instant.
 *
 * With the default `day_start_hour` of 4, anything before 04:00 local time
 * still belongs to the previous day — so a late-night session is one session.
 */
export function dayKey(now: Date, dayStartHour: number): string {
	const shifted = new Date(now.getTime() - dayStartHour * 3_600_000);
	const y = shifted.getFullYear();
	const m = String(shifted.getMonth() + 1).padStart(2, "0");
	const d = String(shifted.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * In-memory view of today's counters, with a persistence callback supplied by
 * the plugin (counters live in the plugin's `data.json`, not in the vault).
 */
export class DailyLedger {
	private record: DailyRecord;

	constructor(
		record: DailyRecord | undefined,
		private dayStartHour: number,
		private persist: (record: DailyRecord) => Promise<void>,
	) {
		this.record = record ?? emptyDaily(dayKey(new Date(), dayStartHour));
	}

	/** Update the rollover hour; may roll the day over immediately. */
	setDayStartHour(hour: number): void {
		this.dayStartHour = hour;
		this.rollover(new Date());
	}

	/** Current counters, after rolling the day over if needed. */
	current(now: Date = new Date()): DailyRecord {
		this.rollover(now);
		return this.record;
	}

	private rollover(now: Date): void {
		const key = dayKey(now, this.dayStartHour);
		if (this.record.day !== key) this.record = emptyDaily(key);
	}

	/** Cards introduced today in this deck. */
	introduced(deck: string, now: Date = new Date()): number {
		return this.current(now).introduced[normaliseDeck(deck)] ?? 0;
	}

	/** Non-new grades submitted today in this deck. */
	reviews(deck: string, now: Date = new Date()): number {
		return this.current(now).reviews[normaliseDeck(deck)] ?? 0;
	}

	/** Introductions across all decks today. */
	introducedTotal(now: Date = new Date()): number {
		return this.current(now).introduced_total;
	}

	/** Reviews across all decks today. */
	reviewsTotal(now: Date = new Date()): number {
		return this.current(now).reviews_total;
	}

	/** Record an introduction against a deck. */
	async recordIntroduction(deck: string, now: Date = new Date()): Promise<void> {
		const record = this.current(now);
		const key = normaliseDeck(deck);
		record.introduced[key] = (record.introduced[key] ?? 0) + 1;
		record.introduced_total += 1;
		await this.persist(record);
	}

	/** Record a non-new grade against a deck. */
	async recordReview(deck: string, now: Date = new Date()): Promise<void> {
		const record = this.current(now);
		const key = normaliseDeck(deck);
		record.reviews[key] = (record.reviews[key] ?? 0) + 1;
		record.reviews_total += 1;
		await this.persist(record);
	}

	/**
	 * Clear one deck's counters for today, leaving every other deck alone.
	 *
	 * The totals are decremented rather than recomputed, because they are the
	 * global caps' own budget and must stay consistent with the per-deck rows.
	 */
	async clearDeck(deck: string, now: Date = new Date()): Promise<void> {
		const record = this.current(now);
		const key = normaliseDeck(deck);
		const introduced = record.introduced[key] ?? 0;
		const reviews = record.reviews[key] ?? 0;
		delete record.introduced[key];
		delete record.reviews[key];
		record.introduced_total = Math.max(0, record.introduced_total - introduced);
		record.reviews_total = Math.max(0, record.reviews_total - reviews);
		await this.persist(record);
	}

	/** Wipe today's counters. Exposed as a command for when a limit was wrong. */
	async reset(now: Date = new Date()): Promise<void> {
		this.record = emptyDaily(dayKey(now, this.dayStartHour));
		await this.persist(this.record);
	}
}
