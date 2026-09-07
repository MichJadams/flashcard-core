/**
 * The two blocks that make a deck note a control panel.
 *
 *   - ```flashcard-deck-stats     — what this deck looks like right now.
 *   - ```flashcard-deck-settings  — the knobs, written straight to frontmatter.
 *
 * Both default to the deck of the note they sit in, which is what makes an
 * empty block work inside `flashcard-core-deck.md`. A `deck:` line overrides
 * that, so a dashboard note can show any deck it likes — and it takes either
 * the deck's id or its display name, since ids are not meant to be typed.
 */

import { MarkdownRenderChild, Setting, TFile, type MarkdownPostProcessorContext } from "obsidian";

import type { CardState, DeckConfig } from "../types";
import { deckFromMetadata } from "./deck-notes";
import { parseDeck } from "./flashcard-block";
import type FlashcardCorePlugin from "../main";

/** Order states are shown in: the path a card actually travels. */
const STATE_LABELS: [CardState, string][] = [
	["new", "New"],
	["learning", "Learning"],
	["review", "Review"],
	["relearning", "Relearning"],
];

/**
 * Shared plumbing: work out which deck this block is about, and redraw when
 * anything it displays changes.
 */
abstract class DeckBlock extends MarkdownRenderChild {
	private ref: string | undefined;
	protected deck: string | undefined;
	private unsubscribers: (() => void)[] = [];

	constructor(
		protected plugin: FlashcardCorePlugin,
		source: string,
		el: HTMLElement,
		protected ctx: MarkdownPostProcessorContext,
	) {
		super(el);
		this.ref = parseDeck(source);
	}

	onload(): void {
		this.containerEl.addClass("fc-deck-panel");
		this.unsubscribers.push(this.plugin.store.onChange(() => this.render()));
		this.unsubscribers.push(this.plugin.decks.onChange(() => this.render()));
		this.render();
	}

	onunload(): void {
		for (const off of this.unsubscribers) off();
		this.unsubscribers = [];
	}

	/** The deck id declared by the note holding this block, if it is a deck note. */
	private deckFromHostNote(): string | undefined {
		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!(file instanceof TFile)) return undefined;
		const note = deckFromMetadata(
			file.path,
			this.plugin.app.metadataCache.getFileCache(file),
		);
		return note?.id;
	}

	protected render(): void {
		this.containerEl.empty();
		// Resolved per render, not once in the constructor: on a cold start the
		// deck index is still filling in, and the host note's own frontmatter
		// may not be in the metadata cache yet either.
		this.deck =
			this.ref !== undefined ? this.plugin.decks.byRef(this.ref) : this.deckFromHostNote();

		if (this.deck === undefined || this.deck === "") {
			this.containerEl.createEl("p", {
				cls: "fc-deck-empty",
				text:
					"No deck. Put this block in a flashcard-core-deck.md note, or name one " +
					"with a `deck: <id>` line inside the block.",
			});
			return;
		}
		this.draw(this.deck);
	}

	protected abstract draw(deck: string): void;
}

/** Card counts, what is due, and how much of today's allowance is left. */
export class DeckStatsBlock extends DeckBlock {
	protected draw(deck: string): void {
		const stats = this.plugin.api.getDeckStats(deck);
		const config = this.plugin.decks.resolve(deck);
		const total = STATE_LABELS.reduce((sum, [state]) => sum + stats.counts[state], 0);

		const header = this.containerEl.createDiv({ cls: "fc-deck-head" });
		header.createEl("span", { cls: "fc-deck-title", text: config.name });
		if (config.name !== deck) header.createEl("code", { cls: "fc-deck-id", text: deck });
		if (!config.enabled) header.createEl("span", { cls: "fc-deck-off", text: "disabled" });

		if (total === 0) {
			this.containerEl.createEl("p", {
				cls: "fc-deck-empty",
				text: "No cards in this deck yet.",
			});
			return;
		}

		const tiles = this.containerEl.createDiv({ cls: "fc-deck-tiles" });
		tile(tiles, "Cards", String(total));
		tile(tiles, "Due now", String(stats.due_now));
		for (const [state, label] of STATE_LABELS) {
			tile(tiles, label, String(stats.counts[state]));
		}

		const today = this.containerEl.createDiv({ cls: "fc-deck-today" });
		today.createEl("div", {
			text: `New today: ${stats.introduced_today} of ${config.new_per_day} · ${stats.new_remaining} left`,
		});
		today.createEl("div", {
			text: `Reviews today: ${stats.reviews_today} of ${config.max_reviews_per_day} · ${stats.reviews_remaining} left`,
		});

		// The global caps are invisible in the per-deck numbers above, so say
		// when one of them — not this deck's own limit — is what is binding.
		const global = this.plugin.decks.global();
		const capped: string[] = [];
		if (global.new_per_day_cap !== null && stats.new_remaining < config.new_per_day - stats.introduced_today) {
			capped.push(`the ${global.new_per_day_cap}/day collection cap on new cards`);
		}
		if (
			global.reviews_per_day_cap !== null &&
			stats.reviews_remaining < config.max_reviews_per_day - stats.reviews_today
		) {
			capped.push(`the ${global.reviews_per_day_cap}/day collection cap on reviews`);
		}
		if (capped.length > 0) {
			today.createEl("div", {
				cls: "fc-deck-note",
				text: `Held back by ${capped.join(" and ")}.`,
			});
		}
	}
}

/** Editable deck fields, written straight into the note's frontmatter. */
export class DeckSettingsBlock extends DeckBlock {
	protected draw(deck: string): void {
		const config = this.plugin.decks.resolve(deck);
		const own = this.plugin.decks.raw(deck);

		if (own === null) {
			this.containerEl.createEl("p", {
				cls: "fc-deck-empty",
				text: `"${deck}" has no flashcard-core-deck.md note, so there is nothing to edit yet.`,
			});
			return;
		}

		new Setting(this.containerEl)
			.setName("Name")
			.setDesc("Shown wherever this deck is listed.")
			.addText((text) => {
				text.setPlaceholder(deck).setValue(own.name ?? "");
				commitOn(text.inputEl, (value) =>
					this.write(deck, { name: value.trim() === "" ? undefined : value.trim() }),
				);
			});

		new Setting(this.containerEl)
			.setName("New cards per day")
			.setDesc("How many unseen cards this deck may introduce in a review day.")
			.addText((text) => {
				text
					.setPlaceholder(String(this.plugin.decks.global().defaults.new_per_day))
					.setValue(own.new_per_day === undefined ? "" : String(own.new_per_day));
				commitOn(text.inputEl, (value) => this.writeCount(deck, "new_per_day", value));
			});

		new Setting(this.containerEl)
			.setName("Reviews per day")
			.setDesc("Cap on cards already in rotation. Empty uses the collection default.")
			.addText((text) => {
				text
					.setPlaceholder(String(this.plugin.decks.global().defaults.max_reviews_per_day))
					.setValue(own.max_reviews_per_day === undefined ? "" : String(own.max_reviews_per_day));
				commitOn(text.inputEl, (value) => this.writeCount(deck, "max_reviews_per_day", value));
			});

		new Setting(this.containerEl)
			.setName("Enabled")
			.setDesc("Off keeps the cards but takes the deck out of every queue.")
			.addToggle((toggle) =>
				toggle
					.setValue(config.enabled)
					.onChange((value) => void this.write(deck, { enabled: value })),
			);

		new Setting(this.containerEl)
			.setName("Target retention")
			.setDesc(
				"Recall probability FSRS schedules for, 0.7 to 0.98. Lower means fewer reviews and more forgetting.",
			)
			.addText((text) => {
				text
					.setPlaceholder("0.9")
					.setValue(
						own.fsrs_params?.request_retention === undefined
							? ""
							: String(own.fsrs_params.request_retention),
					);
				commitOn(text.inputEl, (value) => this.writeRetention(deck, value));
			});
	}

	/** Persist a change, then redraw from what actually landed on disk. */
	private async write(deck: string, partial: DeckConfig): Promise<void> {
		try {
			await this.plugin.api.setDeckConfig(deck, partial);
		} catch (err) {
			console.error("[flashcard-core] could not write deck config", err);
		}
		this.render();
	}

	/** A blank box means "use the collection default", not zero. */
	private async writeCount(
		deck: string,
		field: "new_per_day" | "max_reviews_per_day",
		raw: string,
	): Promise<void> {
		const trimmed = raw.trim();
		if (trimmed === "") {
			await this.write(deck, { [field]: undefined } as DeckConfig);
			return;
		}
		const parsed = Number(trimmed);
		if (!Number.isFinite(parsed) || parsed < 0) {
			this.render();
			return;
		}
		await this.write(deck, { [field]: Math.floor(parsed) } as DeckConfig);
	}

	private async writeRetention(deck: string, raw: string): Promise<void> {
		const trimmed = raw.trim();
		if (trimmed === "") {
			await this.write(deck, { fsrs_params: { request_retention: undefined } });
			return;
		}
		const parsed = Number(trimmed);
		// Outside this range FSRS either thrashes or stops scheduling usefully.
		if (!Number.isFinite(parsed) || parsed < 0.7 || parsed > 0.98) {
			this.render();
			return;
		}
		await this.write(deck, { fsrs_params: { request_retention: parsed } });
	}
}

/** One labelled number in the stats grid. */
function tile(parent: HTMLElement, label: string, value: string): void {
	const el = parent.createDiv({ cls: "fc-deck-tile" });
	el.createEl("div", { cls: "fc-deck-tile-value", text: value });
	el.createEl("div", { cls: "fc-deck-tile-label", text: label });
}

/**
 * Commit a text field on blur and on Enter, rather than per keystroke.
 *
 * Every commit rewrites the note's frontmatter, so typing "15" must not mean
 * saving 1 and then 15 — and a half-typed value must never reach disk.
 */
function commitOn(input: HTMLInputElement, commit: (value: string) => void): void {
	let last = input.value;
	const run = () => {
		if (input.value === last) return;
		last = input.value;
		commit(input.value);
	};
	input.addEventListener("blur", run);
	input.addEventListener("keydown", (evt: KeyboardEvent) => {
		if (evt.key === "Enter") {
			evt.preventDefault();
			run();
		}
	});
}
