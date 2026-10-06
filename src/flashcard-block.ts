/**
 * The ```flashcard code block — a deck's review queue, in the note.
 *
 * The block stores one thing, the deck, and decides between two states every
 * time it renders: cards waiting means the review interface, nothing waiting
 * means saying so. Reviewing here grades through the same API the modal uses,
 * so a card done in a note is a card done everywhere.
 */

import {
	MarkdownRenderChild,
	Notice,
	TFile,
	type MarkdownPostProcessorContext,
} from "obsidian";

import type { ParsedHotkey } from "./hotkeys";
import { DeckPickerModal } from "./deck-picker";
import { normaliseDeck } from "./note";
import { ReviewView } from "./review-view";
import type FlashcardCorePlugin from "../main";

/** How long to wait for the index to settle before re-checking an idle block. */
const REFRESH_DEBOUNCE_MS = 500;

export class FlashcardBlock extends MarkdownRenderChild {
	private ref: string | undefined;
	private deck: string | undefined;
	/** `default speed:` from the block — slower audio for sentences that are nearly there. */
	private speed: number | undefined;
	private view: ReviewView | null = null;

	/** Bindings the mounted view asked for; empty whenever nothing is mounted. */
	private keys: { hotkey: ParsedHotkey; run: () => void }[] = [];

	private unsubscribe: (() => void) | null = null;
	private refreshTimer: number | null = null;
	/** Guards against a slow queue build landing after the block is gone. */
	private generation = 0;

	constructor(
		private plugin: FlashcardCorePlugin,
		source: string,
		el: HTMLElement,
		private ctx: MarkdownPostProcessorContext,
	) {
		super(el);
		// The written reference, which may be a name; resolved to an id lazily,
		// because the deck index is still filling in on a cold start.
		this.ref = parseDeck(source);
		this.speed = parseSpeed(source);
	}

	onload(): void {
		this.containerEl.addClass("fc-block");
		this.containerEl.tabIndex = -1;

		// Keys reach the view only while the pointer or keyboard is inside this
		// block. A grade key must never fire because a note happens to be open.
		this.containerEl.addEventListener("keydown", (evt) => this.onKeyDown(evt));
		this.containerEl.addEventListener("mousedown", () => {
			window.setTimeout(() => this.keepFocus(), 0);
		});

		// The index is still being built on a cold start, so "nothing due" can
		// be a lie for the first second. Re-check when the store settles.
		this.unsubscribe = this.plugin.store.onChange(() => this.scheduleRefresh());

		void this.refresh();
	}

	onunload(): void {
		this.generation += 1;
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.teardownView();
	}

	// -- state --------------------------------------------------------------

	/**
	 * Draw whichever state applies now.
	 *
	 * Never interrupts a review in progress: a card graded elsewhere changes
	 * the index, and pulling the card out from under the learner mid-answer
	 * would be worse than showing a queue that is one card stale.
	 */
	private async refresh(): Promise<void> {
		if (this.view) return;
		const generation = ++this.generation;

		this.deck = this.ref === undefined ? undefined : this.plugin.decks.byRef(this.ref);

		if (!this.deck) {
			this.renderPicker();
			return;
		}

		const queue = await this.plugin.api.buildQueue({ deck: this.deck });
		if (generation !== this.generation) return;

		if (queue.length === 0) {
			this.renderIdle();
			return;
		}

		this.containerEl.empty();
		const host = this.containerEl.createDiv();
		this.view = new ReviewView(this.plugin.app, this.plugin, host, this.deck, queue, {
			bindKey: (hotkey, run) => this.keys.push({ hotkey, run }),
			playbackRate: this.speed,
			// No close: a block stays on the page. When the queue runs dry it
			// goes back to the message rather than stranding a summary.
			onEmpty: () => {
				this.teardownView();
				this.renderIdle();
			},
		});
		this.view.mount();
	}

	private scheduleRefresh(): void {
		if (this.view) return;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	private teardownView(): void {
		this.view?.unmount();
		this.view = null;
		this.keys = [];
	}

	// -- rendering ----------------------------------------------------------

	/** Nothing chosen yet: the block's whole job is to get a deck written into it. */
	private renderPicker(): void {
		const el = this.containerEl;
		el.empty();
		const box = el.createDiv({ cls: "fc-block-empty" });
		box.createDiv({ cls: "fc-block-title", text: "No deck selected" });
		box.createDiv({
			cls: "fc-block-hint",
			text: "Pick the deck this block reviews. It is written into the block, so it sticks.",
		});
		const button = box.createEl("button", { cls: "mod-cta", text: "Choose deck…" });
		button.addEventListener("click", () => this.chooseDeck());
	}

	/** A deck with nothing waiting. The one line the reader came for, plus why. */
	private renderIdle(): void {
		const el = this.containerEl;
		el.empty();
		const box = el.createDiv({ cls: "fc-block-empty" });
		box.createDiv({ cls: "fc-block-title", text: "No cards currently to review" });
		box.createDiv({ cls: "fc-block-hint", text: this.idleDetail() });

		const row = box.createDiv({ cls: "fc-block-actions" });
		const again = row.createEl("button", { text: "Check again" });
		again.addEventListener("click", () => void this.refresh());
		const change = row.createEl("button", { cls: "fc-block-change", text: "Change deck" });
		change.addEventListener("click", () => this.chooseDeck());
	}

	/**
	 * Why the queue is empty, in the deck's own numbers.
	 *
	 * "Nothing due" and "the daily cap is spent" look identical from the
	 * outside and mean very different things, so the counts are worth the line.
	 */
	private idleDetail(): string {
		const deck = this.deck ?? "";
		try {
			const stats = this.plugin.api.getDeckStats(deck);
			const total =
				stats.counts.new +
				stats.counts.learning +
				stats.counts.review +
				stats.counts.relearning;
			const label = this.plugin.decks.resolve(deck).name;
			if (total === 0) return `${label} · no cards in this deck yet`;
			const parts = [
				`${stats.due_now} due`,
				`${finite(stats.new_remaining)} new left today`,
				`${finite(stats.reviews_remaining)} reviews left today`,
			];
			return `${deck} · ${parts.join(" · ")}`;
		} catch (err) {
			console.error("[flashcard-core] could not read deck stats", err);
			return deck;
		}
	}

	private chooseDeck(): void {
		new DeckPickerModal(
			this.plugin.app,
			this.plugin,
			(deck) => {
				if (!deck) return;
				void this.applyDeck(deck);
			},
			{ includeAll: false },
		).open();
	}

	private async applyDeck(deck: string): Promise<void> {
		if (!(await this.writeDeck(deck))) return;
		this.ref = normaliseDeck(deck);
		this.deck = this.ref;
		this.teardownView();
		await this.refresh();
	}

	// -- keys ---------------------------------------------------------------

	private onKeyDown(evt: KeyboardEvent): void {
		if (this.keys.length === 0) return;
		for (const { hotkey, run } of this.keys) {
			if (!matches(evt, hotkey)) continue;
			evt.preventDefault();
			evt.stopPropagation();
			run();
			// Flipping replaces the focused button, and focus on `body` would
			// take the keys with it.
			this.keepFocus();
			return;
		}
	}

	private keepFocus(): void {
		if (!this.view) return;
		const active = this.containerEl.doc.activeElement;
		if (!active || !this.containerEl.contains(active)) {
			this.containerEl.focus({ preventScroll: true });
		}
	}

	// -- persistence --------------------------------------------------------

	/**
	 * Write `deck: <name>` into this block, replacing an existing key or adding
	 * one on the first line inside the fence. Obsidian re-renders the block off
	 * the file change, which is what actually puts the new deck on screen.
	 */
	private async writeDeck(deck: string): Promise<boolean> {
		const info = this.ctx.getSectionInfo(this.containerEl);
		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!info || !(file instanceof TFile)) {
			new Notice("flashcard-core: could not locate this block in the note.");
			return false;
		}

		try {
			const content = await this.plugin.app.vault.read(file);
			const lines = content.split("\n");
			const indent = /^(\s*)/.exec(lines[info.lineStart] ?? "")?.[1] ?? "";
			const deckLine = `${indent}deck: ${deck}`;

			let replaced = false;
			for (let i = info.lineStart + 1; i < info.lineEnd; i++) {
				if (/^\s*deck\s*:/.test(lines[i])) {
					lines[i] = deckLine;
					replaced = true;
					break;
				}
			}
			if (!replaced) lines.splice(info.lineStart + 1, 0, deckLine);

			await this.plugin.app.vault.modify(file, lines.join("\n"));
			return true;
		} catch (err) {
			console.error("[flashcard-core] could not write the deck to the block", err);
			new Notice("flashcard-core: could not save the deck to this block.");
			return false;
		}
	}
}

/**
 * The deck this block reviews.
 *
 * `deck: language/arabic` is the written form. A bare line is accepted too,
 * since a deck name can never contain a colon — that is the whole difference
 * between the two shapes.
 */
export function parseDeck(source: string): string | undefined {
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#")) continue;

		const keyed = /^deck\s*:\s*(.*)$/i.exec(line);
		const value = keyed ? keyed[1] : line.includes(":") ? "" : line;
		const deck = normaliseDeck(value.trim().replace(/^["']|["']$/g, ""));
		if (deck.length > 0) return deck;
	}
	return undefined;
}

/**
 * Does this keydown match a binding? Modifiers must agree exactly, so `1`
 * grades and `Ctrl+1` — a tab switch — does not.
 */
/**
 * The slowest and fastest speeds a block may ask for. Browsers accept a wider
 * range, but below a quarter speed speech smears into noise and above four
 * times it is gibberish — neither helps anyone hear a sentence.
 */
const MIN_SPEED = 0.25;
const MAX_SPEED = 4;

/**
 * The speed this block plays card audio at, or `undefined` for normal speed.
 *
 * `default speed: 0.75` is the written form; `speed:` is accepted as the short
 * one, and the value may carry an `x` (`0.75x`) or be a percentage (`75%`).
 * "Default" because it is where playback starts — the player's own controls
 * still change it for one listen. A value that is not a usable number is
 * ignored rather than refused: a typo should cost the slowdown, not the block.
 */
export function parseSpeed(source: string): number | undefined {
	for (const raw of source.split("\n")) {
		const keyed = /^\s*(?:default[\s_-]*)?speed\s*:\s*(.*)$/i.exec(raw);
		if (!keyed) continue;

		const value = keyed[1].trim().replace(/^["']|["']$/g, "");
		const match = /^(\d*\.?\d+)\s*(x|%)?$/i.exec(value);
		if (!match) return undefined;
		const n = Number(match[1]) / (match[2] === "%" ? 100 : 1);
		if (!Number.isFinite(n) || n <= 0) return undefined;
		return Math.min(MAX_SPEED, Math.max(MIN_SPEED, n));
	}
	return undefined;
}

function matches(evt: KeyboardEvent, hotkey: ParsedHotkey): boolean {
	if (evt.key.toLowerCase() !== hotkey.key.toLowerCase()) return false;
	const wanted = new Set(hotkey.modifiers.map((m) => m.toLowerCase()));
	return (
		evt.ctrlKey === wanted.has("ctrl") &&
		evt.metaKey === wanted.has("meta") &&
		evt.shiftKey === wanted.has("shift") &&
		evt.altKey === wanted.has("alt")
	);
}

function finite(n: number): string {
	return Number.isFinite(n) ? String(n) : "∞";
}
