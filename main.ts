/**
 * flashcard-core — a generic, FSRS-backed flashcard engine for Obsidian.
 *
 * This plugin owns scheduling, storage, deck limits, and review. It owns no
 * subject matter: other plugins generate the cards and hand them over as JSON
 * or through the runtime API. See `types.ts` for the contract and `README.md`
 * for the integration guide.
 */

import { Notice, Plugin, TFile } from "obsidian";

import type { FlashcardCoreAPI, QueueItem } from "./types";
import { FlashcardCore } from "./src/api";
import { DailyLedger } from "./src/daily";
import { DeckNoteStore } from "./src/deck-notes";
import { DeckPickerModal } from "./src/deck-picker";
import { DeckSettingsBlock, DeckStatsBlock } from "./src/deck-block";
import { FlashcardBlock } from "./src/flashcard-block";
import { DEFAULT_HOTKEYS, withDefaults } from "./src/hotkeys";
import { blockedBy } from "./src/queue";
import { ReviewModal } from "./src/review-modal";
import { Scheduler } from "./src/scheduler";
import { CardStore } from "./src/store";
import {
	DEFAULT_SETTINGS,
	FlashcardCoreSettingTab,
	type FlashcardCoreSettings,
} from "./src/settings";

export default class FlashcardCorePlugin extends Plugin {
	settings!: FlashcardCoreSettings;
	scheduler!: Scheduler;
	decks!: DeckNoteStore;
	ledger!: DailyLedger;
	store!: CardStore;

	/**
	 * The public API. Other plugins reach it with:
	 *
	 * ```ts
	 * const core = app.plugins.getPlugin("flashcard-core")?.api as FlashcardCoreAPI;
	 * ```
	 */
	api!: FlashcardCoreAPI;

	private core!: FlashcardCore;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.scheduler = new Scheduler();

		// Deck config lives in the vault's deck notes; only the collection-wide
		// defaults are the plugin's own, so they ride along in `data.json`.
		this.decks = new DeckNoteStore(
			this.app,
			() => this.settings.deckGlobals,
			async (next) => {
				this.settings.deckGlobals = next;
				await this.saveSettings();
			},
		);

		this.ledger = new DailyLedger(
			this.settings.daily,
			this.settings.deckGlobals.day_start_hour,
			async (record) => {
				this.settings.daily = record;
				await this.saveSettings();
			},
		);

		// Cards belong in their deck's own folder when the deck declares one.
		this.store = new CardStore(
			this.app,
			this.settings.root,
			(deck) => this.decks.resolve(deck).folder,
		);
		this.core = new FlashcardCore({
			app: this.app,
			store: this.store,
			decks: this.decks,
			ledger: this.ledger,
			scheduler: this.scheduler,
			openReview: (deck, queue) => this.openReview(deck, queue),
		});
		this.api = this.core;

		// The metadata cache is not populated until layout is ready, so the
		// initial scans have to wait or they find nothing on a cold start.
		this.app.workspace.onLayoutReady(() => {
			this.decks.start();
			this.store.start();
		});

		// A deck's queue, in the note. `deck:` inside the block says which.
		this.registerMarkdownCodeBlockProcessor("flashcard", (source, el, ctx) => {
			ctx.addChild(new FlashcardBlock(this, source, el, ctx));
		});

		// The two halves of a deck note: what the deck looks like, and its knobs.
		this.registerMarkdownCodeBlockProcessor("flashcard-deck-stats", (source, el, ctx) => {
			ctx.addChild(new DeckStatsBlock(this, source, el, ctx));
		});
		this.registerMarkdownCodeBlockProcessor("flashcard-deck-settings", (source, el, ctx) => {
			ctx.addChild(new DeckSettingsBlock(this, source, el, ctx));
		});

		this.addSettingTab(new FlashcardCoreSettingTab(this.app, this));
		this.registerCommands();

		this.addRibbonIcon("layers", "Review flashcards", () => {
			void this.promptReview();
		});
	}

	onunload(): void {
		this.store?.stop();
		this.decks?.stop();
	}

	// -- settings -----------------------------------------------------------

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<FlashcardCoreSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };

		// Fill in any action added since this vault last saved, so a new binding
		// is never silently missing.
		this.settings.hotkeys = withDefaults(this.settings.hotkeys);

		// Migration: `spaceToFlip: false` used to mean "Space does nothing".
		const legacy = data as { spaceToFlip?: boolean } | null;
		if (legacy?.spaceToFlip === false && this.settings.hotkeys.advance === DEFAULT_HOTKEYS.advance) {
			this.settings.hotkeys.advance = "";
		}
		delete (this.settings as unknown as Record<string, unknown>)["spaceToFlip"];
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Re-point the card store after the root folder setting changes.
	 *
	 * Deck config needs nothing here: deck notes are found by their
	 * frontmatter, wherever they live, so a wrong root can no longer silently
	 * cost every deck its settings.
	 */
	async applyRoot(): Promise<void> {
		this.store.setRoot(this.settings.root);
		this.scheduler.invalidate();
		this.store.rebuild();
	}

	// -- UI -----------------------------------------------------------------

	private openReview(deck: string | undefined, queue: QueueItem[]): void {
		new ReviewModal(this.app, this, queue, deck).open();
	}

	private async promptReview(): Promise<void> {
		new DeckPickerModal(this.app, this, (deck) => {
			void this.api.startReview(deck);
		}).open();
	}

	// -- commands -----------------------------------------------------------

	private registerCommands(): void {
		this.addCommand({
			id: "review-all",
			name: "Review all decks",
			callback: () => void this.api.startReview(),
		});

		this.addCommand({
			id: "review-deck",
			name: "Review a deck…",
			callback: () => void this.promptReview(),
		});

		this.addCommand({
			id: "review-current-deck",
			name: "Review the deck of the active card",
			checkCallback: (checking) => {
				const deck = this.activeCardDeck();
				if (!deck) return false;
				if (!checking) void this.api.startReview(deck);
				return true;
			},
		});

		this.addCommand({
			id: "rebuild-index",
			name: "Rebuild card index",
			callback: () => {
				this.store.rebuild();
				new Notice(`flashcard-core: indexed ${this.store.all().length} cards.`);
			},
		});

		this.addCommand({
			id: "deck-stats",
			name: "Show deck statistics",
			callback: () => {
				new DeckPickerModal(this.app, this, (deck) => {
					const stats = this.api.getDeckStats(deck ?? "");
					const { counts } = stats;
					new Notice(
						[
							deck === undefined ? "All decks" : this.decks.resolve(deck).name,
							`due now: ${stats.due_now}`,
							`new left today: ${stats.new_remaining}`,
							`reviews left today: ${stats.reviews_remaining}`,
							`new ${counts.new} · learning ${counts.learning} · review ${counts.review} · relearning ${counts.relearning}`,
						].join("\n"),
						10_000,
					);
				}).open();
			},
		});

		this.addCommand({
			id: "why-blocked",
			name: "Why is this card not being introduced?",
			checkCallback: (checking) => {
				const card = this.activeCard();
				if (!card) return false;
				if (!checking) {
					const index = new Map(this.store.all().map((c) => [c.id, c]));
					const reasons = blockedBy(card, index);
					if (card.fsrs.state !== "new") {
						new Notice(`${card.id} is not new (state: ${card.fsrs.state}).`, 8000);
					} else if (reasons.length === 0) {
						const stats = this.api.getDeckStats(card.deck);
						new Notice(
							stats.new_remaining > 0
								? `${card.id} is eligible; it is queued behind cards with a lower fc_new_order.`
								: `${card.id} is eligible, but ${card.deck} has no new cards left today.`,
							8000,
						);
					} else {
						new Notice(`${card.id} is gated by:\n${reasons.join("\n")}`, 10_000);
					}
				}
				return true;
			},
		});

		this.addCommand({
			id: "forget-card",
			name: "Reset the active card to new",
			checkCallback: (checking) => {
				const card = this.activeCard();
				if (!card) return false;
				if (!checking) {
					void this.api
						.forgetCard(card.id)
						.then(() => new Notice(`flashcard-core: ${card.id} reset to new.`))
						.catch((err: unknown) => new Notice(`flashcard-core: ${describe(err)}`));
				}
				return true;
			},
		});

		this.addCommand({
			id: "list-providers",
			name: "List registered new-card order providers",
			callback: () => {
				const providers = this.core.listProviders();
				new Notice(
					providers.length === 0
						? "flashcard-core: no order providers registered; decks use fc_new_order."
						: providers.map((p) => `${p.id} → ${p.deck || "(all decks)"}`).join("\n"),
					8000,
				);
			},
		});

		this.addCommand({
			id: "create-base",
			name: "Create a Bases view for the collection",
			callback: () => void this.createBaseFile(),
		});
	}

	private activeCard() {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) return null;
		return this.store.all().find((card) => card.path === file.path) ?? null;
	}

	private activeCardDeck(): string | null {
		return this.activeCard()?.deck ?? null;
	}

	/**
	 * Write a starter `.base` file.
	 *
	 * The frontmatter schema exists to make this possible — browsing and
	 * managing the collection is Bases' job, not this plugin's.
	 */
	private async createBaseFile(): Promise<void> {
		const path = `${this.settings.root}/Flashcards.base`;
		if (await this.app.vault.adapter.exists(path)) {
			new Notice(`flashcard-core: ${path} already exists.`);
			return;
		}
		const folder = this.settings.root;
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder).catch(() => undefined);
		}
		await this.app.vault.create(path, BASE_TEMPLATE);
		new Notice(`flashcard-core: created ${path}.`);
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Starter Bases view.
 *
 * `fc == "card"` is the anchor filter and `deck` is the grouping key — the two
 * frontmatter properties the card format exists to expose.
 */
const BASE_TEMPLATE = `filters:
  and:
    - 'fc == "card"'
formulas:
  overdue_days: 'if(fsrs_due, (now() - date(fsrs_due)).days.round(1))'
properties:
  deck:
    displayName: Deck
  fsrs_due:
    displayName: Due
  fsrs_state:
    displayName: State
  fsrs_stability:
    displayName: Stability
  fsrs_lapses:
    displayName: Lapses
  source_plugin:
    displayName: Source
  formula.overdue_days:
    displayName: Overdue (d)
views:
  - type: table
    name: Due now
    filters:
      and:
        - 'fsrs_state != "new"'
        - 'date(fsrs_due) <= now()'
    order:
      - file.name
      - deck
      - fsrs_due
      - fsrs_state
      - formula.overdue_days
    sort:
      - property: fsrs_due
        direction: ASC
  - type: table
    name: By deck
    groupBy:
      property: deck
      direction: ASC
    order:
      - file.name
      - fsrs_state
      - fsrs_due
      - fsrs_stability
      - fsrs_reps
      - fsrs_lapses
  - type: table
    name: New backlog
    filters:
      and:
        - 'fsrs_state == "new"'
    order:
      - file.name
      - deck
      - fc_new_order
      - fc_prerequisites
    sort:
      - property: fc_new_order
        direction: ASC
  - type: table
    name: Leeches
    filters:
      and:
        - 'fsrs_lapses >= 4'
    order:
      - file.name
      - deck
      - fsrs_lapses
      - fsrs_difficulty
    sort:
      - property: fsrs_lapses
        direction: DESC
`;
