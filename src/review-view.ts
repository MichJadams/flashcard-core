/**
 * The review UI — one card at a time, hidden answer, four grades.
 *
 * Deliberately free of any surface of its own: it draws into whatever element
 * it is given and asks its host for the two things that differ between
 * surfaces — how to bind a key, and what "done" means. The modal and the
 * `flashcard` code block are both thin shells around this.
 */

import { Component, MarkdownRenderer, Notice, type App } from "obsidian";

import type { CardContent, CardRecord, QueueItem, RatingPreview } from "../types";
import { Rating } from "../types";
import { DEFAULT_SESSION_CONFIG, SessionQueue, type SessionEntry } from "./session";
import {
	parseHotkey,
	REVIEW_ACTIONS,
	withDefaults,
	type ParsedHotkey,
	type ReviewActionId,
} from "./hotkeys";
import type FlashcardCorePlugin from "../main";

/**
 * What a surface has to provide.
 *
 * `close` and `onEmpty` are optional because a code block has neither: it
 * cannot be closed, and when its queue runs dry it goes back to saying so
 * rather than showing a summary the reader can't dismiss.
 */
export interface ReviewViewHost {
	/** Bind a review action in whatever scope the surface owns. */
	bindKey(hotkey: ParsedHotkey, run: () => void): void;
	/** Dismiss the surface. Absent for one that stays on the page. */
	close?: () => void;
	/** The queue emptied and a refill found nothing more. */
	onEmpty?: () => void;
}

interface GradeButton {
	rating: Rating;
	label: string;
	cls: string;
	/** The rebindable action this button mirrors, so its label shows the live key. */
	action: ReviewActionId;
}

const GRADES: GradeButton[] = [
	{ rating: Rating.Again, label: "Again", cls: "fc-grade-again", action: "again" },
	{ rating: Rating.Hard, label: "Hard", cls: "fc-grade-hard", action: "hard" },
	{ rating: Rating.Good, label: "Good", cls: "fc-grade-good", action: "good" },
	{ rating: Rating.Easy, label: "Easy", cls: "fc-grade-easy", action: "easy" },
];

export class ReviewView {
	/** The live queue. Cards graded Again come back through it, so it is not the built order. */
	private session: SessionQueue;
	private flipped = false;
	private grading = false;
	private reviewed = 0;
	private introduced = 0;

	private headerEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private cardEl!: HTMLElement;
	private controlsEl!: HTMLElement;

	/** Owns the lifecycle of the rendered children for the card on screen. */
	private renderHost = new Component();

	/** The side the replay action replays from: the back once flipped, the front before that. */
	private audioScope: HTMLElement | null = null;

	/** Bindings resolved once at mount, so a mid-session settings edit cannot desync them. */
	private hotkeys = withDefaults(undefined);

	private pending: CardContent | null = null;

	constructor(
		private app: App,
		private plugin: FlashcardCorePlugin,
		private containerEl: HTMLElement,
		private deck: string | undefined,
		queue: QueueItem[],
		private host: ReviewViewHost,
	) {
		this.session = this.newSession(queue);
		this.hotkeys = withDefaults(plugin.settings.hotkeys);
	}

	/** How many cards are still ahead, including the one on screen. */
	get remaining(): number {
		return this.session.remaining;
	}

	/** Wrap a built queue in the session pacing the user has configured. */
	private newSession(queue: QueueItem[]): SessionQueue {
		const { againGap, newBatchSize } = this.plugin.settings;
		return new SessionQueue(queue, {
			againGap: againGap ?? DEFAULT_SESSION_CONFIG.againGap,
			newBatchSize: newBatchSize ?? DEFAULT_SESSION_CONFIG.newBatchSize,
		});
	}

	mount(): void {
		const el = this.containerEl;
		el.empty();
		el.addClass("fc-review");

		this.headerEl = el.createDiv({ cls: "fc-review-header" });
		this.progressEl = this.headerEl.createSpan({ cls: "fc-review-progress" });
		this.cardEl = el.createDiv({ cls: "fc-review-card" });
		this.controlsEl = el.createDiv({ cls: "fc-review-controls" });

		this.registerHotkeys();
		void this.renderCurrent();
	}

	unmount(): void {
		this.renderHost.unload();
		this.containerEl.empty();
	}

	/**
	 * Bind every review action to its configured key.
	 *
	 * Grading is reachable only from the four grade actions. `advance` moves
	 * forward and never records anything, so the key you lean on to get through
	 * a session cannot quietly write a grade you did not choose.
	 */
	private registerHotkeys(): void {
		const handlers: Record<ReviewActionId, () => void> = {
			advance: () => {
				if (this.flipped) void this.skip();
				else this.flip();
			},
			reveal: () => this.flip(),
			again: () => this.gradeIfFlipped(Rating.Again),
			hard: () => this.gradeIfFlipped(Rating.Hard),
			good: () => this.gradeIfFlipped(Rating.Good),
			easy: () => this.gradeIfFlipped(Rating.Easy),
			skip: () => void this.skip(),
			replay: () => this.replayAudio(),
		};

		for (const action of REVIEW_ACTIONS) {
			const parsed = parseHotkey(this.hotkeys[action.id]);
			if (!parsed) continue;
			this.host.bindKey(parsed, handlers[action.id]);
		}
	}

	/** Grades are inert until the answer is showing. */
	private gradeIfFlipped(rating: Rating): void {
		if (this.flipped) void this.grade(rating);
	}

	/** The key bound to an action, for labelling buttons. Empty when unbound. */
	private keyFor(action: ReviewActionId): string {
		const binding = (this.hotkeys[action] ?? "").trim();
		return binding.length > 0 ? ` (${binding})` : "";
	}

	/** Tear down the previous card's rendered children before drawing the next. */
	private resetRenderHost(): void {
		this.renderHost.unload();
		this.renderHost = new Component();
		this.renderHost.load();
	}

	private get current(): SessionEntry | null {
		return this.session.current;
	}

	// -- rendering ----------------------------------------------------------

	private async renderCurrent(): Promise<void> {
		this.flipped = false;
		const entry = this.current;

		if (!entry) {
			this.renderFinished();
			return;
		}
		const item = entry.item;

		// Cards return after Again, so a position out of a fixed total would be
		// a lie. What is left is the number that stays true either way.
		// The deck's name, never its id: an id is opaque by design and means
		// nothing to the person reading it mid-review.
		const deckLabel = this.plugin.decks.resolve(item.card.deck).name;
		this.progressEl.setText(
			`${this.session.remaining} left · ${deckLabel} · ${labelFor(entry)}`,
		);

		this.resetRenderHost();
		this.cardEl.empty();
		this.controlsEl.empty();

		const content = await this.plugin.api.getCardContent(item.card.id);
		if (!content) {
			new Notice(`flashcard-core: could not read ${item.card.path}`);
			this.session.drop();
			await this.renderCurrent();
			return;
		}

		// Stash the parsed content before rendering. Nothing about showing the
		// answer may depend on the front having rendered successfully.
		this.pending = content;

		const flipButton = this.controlsEl.createEl("button", {
			cls: "fc-flip mod-cta",
			text: `Show answer${this.keyFor("advance") || this.keyFor("reveal")}`,
		});
		flipButton.addEventListener("click", () => this.flip());
		flipButton.focus();
		if (hasAudio(content.front)) this.addReplayButton();

		const frontEl = this.cardEl.createDiv({ cls: "fc-side fc-front" });
		this.audioScope = frontEl;
		await this.render(content.front, frontEl, item.card.path);
		this.autoplay(frontEl);
	}

	/** A clickable twin for the `r` shortcut, shown only when the card has audio. */
	private addReplayButton(): void {
		const button = this.controlsEl.createEl("button", {
			cls: "fc-replay",
			text: `Replay audio${this.keyFor("replay")}`,
		});
		button.addEventListener("click", () => this.replayAudio());
	}

	private flip(): void {
		if (this.flipped || !this.pending) return;
		this.flipped = true;
		const entry = this.current;
		if (!entry) return;
		const item = entry.item;

		this.controlsEl.empty();
		this.cardEl.createEl("hr", { cls: "fc-divider" });

		const backEl = this.cardEl.createDiv({ cls: "fc-side fc-back" });
		this.audioScope = backEl;
		void this.render(this.pending.back, backEl, item.card.path).then(() => this.autoplay(backEl));

		if (this.pending.extra) {
			const extraEl = this.cardEl.createDiv({ cls: "fc-side fc-extra" });
			void this.render(this.pending.extra, extraEl, item.card.path);
		}

		// Interval labels are a nicety. A scheduler hiccup on a malformed card
		// must not cost the user their grade buttons.
		let preview: RatingPreview | null = null;
		if (this.plugin.settings.showIntervals) {
			try {
				preview = this.plugin.api.previewRatings(item.card.id);
			} catch (err) {
				console.error("[flashcard-core] could not preview intervals", err);
			}
		}

		const row = this.controlsEl.createDiv({ cls: "fc-grades" });
		for (const grade of GRADES) {
			const button = row.createEl("button", { cls: `fc-grade ${grade.cls}` });
			button.createSpan({
				cls: "fc-grade-label",
				text: `${grade.label}${this.keyFor(grade.action)}`,
			});
			const interval = intervalLabel(preview, grade.rating);
			if (interval) button.createSpan({ cls: "fc-grade-interval", text: interval });
			button.addEventListener("click", () => void this.grade(grade.rating));
		}

		const footer = this.controlsEl.createDiv({ cls: "fc-footer" });
		if (hasAudio(this.pending.front, this.pending.back, this.pending.extra)) {
			const replay = footer.createEl("button", {
				cls: "fc-replay",
				text: `Replay audio${this.keyFor("replay")}`,
			});
			replay.addEventListener("click", () => this.replayAudio());
		}
		const skip = footer.createEl("button", {
			cls: "fc-skip",
			text: `Skip${this.keyFor("skip")}`,
		});
		skip.addEventListener("click", () => void this.skip());
	}

	private renderFinished(): void {
		this.cardEl.empty();
		this.controlsEl.empty();
		this.progressEl.setText(this.deck ? `${this.deck} · done` : "done");

		const done = this.cardEl.createDiv({ cls: "fc-done" });
		done.createEl("h3", { text: "Queue complete" });
		// Grades, not cards: a card sent back after Again is graded more than
		// once, so counting cards here would undercount the work done.
		done.createEl("p", {
			text: `${this.reviewed} grade${this.reviewed === 1 ? "" : "s"} recorded, ${this.introduced} card${this.introduced === 1 ? "" : "s"} newly introduced.`,
		});

		const again = this.controlsEl.createEl("button", {
			cls: "mod-cta",
			text: "Check for more",
		});
		again.addEventListener("click", () => {
			void this.refill();
		});
		if (this.host.close) {
			const close = this.controlsEl.createEl("button", { text: "Close" });
			close.addEventListener("click", () => this.host.close?.());
		}
		again.focus();
	}

	/**
	 * Rebuild the queue in place.
	 *
	 * Cards graded Again come back within minutes, so "check for more" at the
	 * end of a session is how learning steps actually get finished.
	 */
	private async refill(): Promise<void> {
		const next = await this.plugin.api.buildQueue({ deck: this.deck });
		if (next.length === 0) {
			if (this.host.onEmpty) this.host.onEmpty();
			else new Notice("flashcard-core: nothing due right now.");
			return;
		}
		this.session = this.newSession(next);
		await this.renderCurrent();
	}

	/**
	 * Render Markdown into an element.
	 *
	 * A `Modal` is not a `Component`, so it cannot be passed to the renderer —
	 * doing so blows up inside `addChild`. Each card gets its own `Component`
	 * instead, unloaded when the card is left so embedded audio and images are
	 * torn down with it.
	 *
	 * Failures are contained: a card that will not render still has to be
	 * gradable, so we fall back to plain text rather than aborting the caller.
	 */
	private async render(markdown: string, el: HTMLElement, sourcePath: string): Promise<void> {
		const text = markdown.trim();
		if (text.length === 0) {
			el.createEl("em", { text: "(empty)" });
			return;
		}
		try {
			await MarkdownRenderer.render(this.app, text, el, sourcePath, this.renderHost);
		} catch (err) {
			console.error("[flashcard-core] Markdown render failed; showing plain text", err);
			el.empty();
			el.createEl("pre", { text });
		}
	}

	/** Play the first audio embed in a side, if the user wants that. */
	private autoplay(el: HTMLElement): void {
		if (!this.plugin.settings.autoplayAudio) return;
		// Obsidian mounts the <audio> element asynchronously after render.
		window.setTimeout(() => play(findAudio(el)), 60);
	}

	/**
	 * Restart the audio on the side currently showing. Bound to `r`.
	 *
	 * Prefers the visible side, then falls back to anywhere on the card, so a
	 * card whose audio sits on the front is still replayable after the flip —
	 * which is exactly when a listening prompt gets replayed most.
	 */
	private replayAudio(): void {
		play(findAudio(this.audioScope) ?? findAudio(this.cardEl));
	}

	// -- grading ------------------------------------------------------------

	private async grade(rating: Rating): Promise<void> {
		const entry = this.current;
		if (!entry || this.grading) return;
		this.grading = true;
		let updated: CardRecord | null = null;
		try {
			const result = await this.plugin.api.reviewCard(entry.item.card.id, rating);
			updated = result.card;
			this.reviewed += 1;
			if (result.introduced) this.introduced += 1;
		} catch (err) {
			new Notice(`flashcard-core: ${err instanceof Error ? err.message : String(err)}`);
			// The grade never landed, so nothing was learned about this card and
			// sending it back would be pacing on a fiction. Move on; the queue is
			// rebuildable, the write is what matters.
			this.grading = false;
			this.session.drop();
			await this.renderCurrent();
			return;
		}
		this.grading = false;
		this.session.graded(rating, updated);
		await this.renderCurrent();
	}

	/** Move past a card without grading it. Nothing is written, nothing counted. */
	private async skip(): Promise<void> {
		this.session.drop();
		await this.renderCurrent();
	}
}

/** Audio embeds, as written by the ingestion layer. Mirrors the extensions in `note.ts`. */
const AUDIO_EMBED = /!\[\[[^\]]+\.(?:mp3|wav|m4a|ogg|flac|webm|3gp)(?:\|[^\]]*)?\]\]/i;

/** Does any of this Markdown embed audio? Decides whether to offer the replay button. */
export function hasAudio(...parts: (string | null | undefined)[]): boolean {
	return parts.some((part) => typeof part === "string" && AUDIO_EMBED.test(part));
}

function findAudio(el: HTMLElement | null): HTMLAudioElement | null {
	const found = el?.querySelector("audio");
	return found instanceof HTMLAudioElement ? found : null;
}

/** Restart from the beginning — a replay the user asked for should always be audible. */
function play(audio: HTMLAudioElement | null): void {
	if (!audio) return;
	audio.currentTime = 0;
	void audio.play().catch(() => undefined);
}

/**
 * The line under the deck name. The retry count is the point of it: seeing
 * "again ×2" is what tells you this card is being drilled rather than that the
 * queue has stalled.
 */
function labelFor(entry: SessionEntry): string {
	const { item, retries } = entry;
	if (retries > 0) return `again ×${retries}`;
	if (item.reason === "new") return "new";
	if (item.reason === "learning") return "learning";
	return `review · ${item.card.fsrs.reps} reps`;
}

function intervalLabel(preview: RatingPreview | null, rating: Rating): string | null {
	return preview ? (preview[rating]?.interval_label ?? null) : null;
}
