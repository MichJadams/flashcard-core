/**
 * The one and only place `ts-fsrs` is imported.
 *
 * Everything above this module speaks in {@link FsrsState} — plain JSON with
 * ISO timestamps and lowercase state names — so the library can be upgraded or
 * swapped without touching storage, the queue builder, or the UI.
 */

import {
	createEmptyCard,
	fsrs,
	FSRS,
	Rating as TsRating,
	State as TsState,
	type Card as TsCard,
	type FSRSParameters,
	type Grade,
	type StepUnit,
} from "ts-fsrs";

import type { CardState, DeckFsrsParams, FsrsState, Rating, RatingPreview } from "../types";

// ---------------------------------------------------------------------------
// State translation
// ---------------------------------------------------------------------------

const STATE_TO_STRING: Record<TsState, CardState> = {
	[TsState.New]: "new",
	[TsState.Learning]: "learning",
	[TsState.Review]: "review",
	[TsState.Relearning]: "relearning",
};

const STRING_TO_STATE: Record<CardState, TsState> = {
	new: TsState.New,
	learning: TsState.Learning,
	review: TsState.Review,
	relearning: TsState.Relearning,
};

const RATING_TO_GRADE: Record<Rating, Grade> = {
	1: TsRating.Again,
	2: TsRating.Hard,
	3: TsRating.Good,
	4: TsRating.Easy,
};

/** Round to 4 decimals so frontmatter stays human-readable and diff-friendly. */
function round(n: number): number {
	return Math.round(n * 10000) / 10000;
}

function toIso(d: Date): string {
	return d.toISOString();
}

/** Convert persisted state into the shape ts-fsrs expects. */
function toTsCard(state: FsrsState): TsCard {
	const last = state.last_review ? new Date(state.last_review) : undefined;
	const due = new Date(state.due);
	return {
		due,
		stability: state.stability,
		difficulty: state.difficulty,
		// Deprecated in ts-fsrs 5.x and removed in 6.0, but still required by the
		// Card interface. Derived rather than persisted.
		elapsed_days: last ? Math.max(0, daysBetween(last, due) - state.scheduled_days) : 0,
		scheduled_days: state.scheduled_days,
		learning_steps: state.learning_steps,
		reps: state.reps,
		lapses: state.lapses,
		state: STRING_TO_STATE[state.state] ?? TsState.New,
		last_review: last,
	};
}

/** Convert a ts-fsrs card back into persisted state. */
function fromTsCard(card: TsCard): FsrsState {
	return {
		due: toIso(card.due),
		stability: round(card.stability),
		difficulty: round(card.difficulty),
		reps: card.reps,
		lapses: card.lapses,
		state: STATE_TO_STRING[card.state] ?? "new",
		last_review: card.last_review ? toIso(card.last_review) : null,
		learning_steps: card.learning_steps ?? 0,
		scheduled_days: card.scheduled_days,
	};
}

function daysBetween(a: Date, b: Date): number {
	return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Parameter handling
// ---------------------------------------------------------------------------

/** Steps must look like `10m` / `2h` / `1d`; anything else is dropped. */
const STEP_PATTERN = /^\d+(?:\.\d+)?[mhd]$/;

function coerceSteps(steps: string[] | undefined): StepUnit[] | undefined {
	if (!steps) return undefined;
	const valid = steps.filter((s) => STEP_PATTERN.test(s)) as StepUnit[];
	return valid.length === steps.length ? valid : valid;
}

/**
 * Translate a deck's `fsrs_params` into ts-fsrs parameters.
 *
 * Only keys the deck actually set are forwarded, so unset keys keep the
 * library's own defaults rather than ours.
 */
function toFsrsParameters(params: DeckFsrsParams): Partial<FSRSParameters> {
	const out: Partial<FSRSParameters> = {};
	if (typeof params.request_retention === "number") out.request_retention = params.request_retention;
	if (typeof params.maximum_interval === "number") out.maximum_interval = params.maximum_interval;
	if (typeof params.enable_fuzz === "boolean") out.enable_fuzz = params.enable_fuzz;
	if (typeof params.enable_short_term === "boolean") out.enable_short_term = params.enable_short_term;
	const learning = coerceSteps(params.learning_steps);
	if (learning) out.learning_steps = learning;
	const relearning = coerceSteps(params.relearning_steps);
	if (relearning) out.relearning_steps = relearning;
	if (Array.isArray(params.w) && params.w.length > 0) out.w = params.w;
	return out;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Thin façade over ts-fsrs.
 *
 * Instances are cheap but not free (each builds a parameter set), so they are
 * cached per distinct deck parameter signature.
 */
export class Scheduler {
	private cache = new Map<string, FSRS>();

	/** Discard cached instances. Call after deck config changes. */
	invalidate(): void {
		this.cache.clear();
	}

	private instance(params: DeckFsrsParams): FSRS {
		const key = JSON.stringify(toFsrsParameters(params));
		let f = this.cache.get(key);
		if (!f) {
			f = fsrs(toFsrsParameters(params));
			this.cache.set(key, f);
		}
		return f;
	}

	/** Fresh state for a card that has never been seen. */
	newState(now: Date = new Date()): FsrsState {
		return fromTsCard(createEmptyCard(now));
	}

	/**
	 * Apply a grade and return the resulting state.
	 *
	 * Pure: the caller is responsible for persisting the result.
	 */
	grade(state: FsrsState, rating: Rating, params: DeckFsrsParams, now: Date = new Date()): FsrsState {
		const f = this.instance(params);
		const result = f.next(toTsCard(state), now, RATING_TO_GRADE[rating]);
		return fromTsCard(result.card);
	}

	/** Outcomes for all four grades, for labelling the review buttons. */
	preview(state: FsrsState, params: DeckFsrsParams, now: Date = new Date()): RatingPreview {
		const f = this.instance(params);
		const log = f.repeat(toTsCard(state), now);
		const at = (grade: Grade) => {
			const due = log[grade].card.due;
			return { due: toIso(due), interval_label: humanInterval(now, due) };
		};
		return {
			1: at(TsRating.Again),
			2: at(TsRating.Hard),
			3: at(TsRating.Good),
			4: at(TsRating.Easy),
		};
	}

	/** Probability the card is still recallable right now, 0-1. */
	retrievability(state: FsrsState, params: DeckFsrsParams, now: Date = new Date()): number {
		if (state.state === "new") return 0;
		return this.instance(params).get_retrievability(toTsCard(state), now, false);
	}

	/** Reset to `new`, discarding history. */
	forget(state: FsrsState, params: DeckFsrsParams, now: Date = new Date()): FsrsState {
		const result = this.instance(params).forget(toTsCard(state), now, true);
		return fromTsCard(result.card);
	}
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `<1m`, `12m`, `3h`, `4d`, `2.5mo`, `1.3y` — Anki-style button labels. */
export function humanInterval(from: Date, to: Date): string {
	const ms = to.getTime() - from.getTime();
	if (ms <= 0) return "now";
	const minutes = ms / 60_000;
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${Math.round(minutes)}m`;
	const hours = minutes / 60;
	if (hours < 24) return `${Math.round(hours)}h`;
	const days = hours / 24;
	if (days < 30) return `${Math.round(days)}d`;
	const months = days / 30.4375;
	if (months < 12) return `${trim(months)}mo`;
	return `${trim(days / 365.25)}y`;
}

function trim(n: number): string {
	return n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
}
