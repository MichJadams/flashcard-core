/**
 * Deck chooser shown when review is started without a deck.
 *
 * Deliberately thin: it lists decks with their outstanding counts and nothing
 * more. Anything richer belongs in a Base.
 */

import { FuzzySuggestModal, type App } from "obsidian";

import type { DeckDailyStats } from "../types";
import type FlashcardCorePlugin from "../main";

interface DeckChoice {
	deck: string;
	label: string;
	stats: DeckDailyStats | null;
}

export interface DeckPickerOptions {
	/** Offer "All decks". Off for a caller that has to end up with a real deck. */
	includeAll?: boolean;
	placeholder?: string;
}

export class DeckPickerModal extends FuzzySuggestModal<DeckChoice> {
	private options: DeckPickerOptions;

	constructor(
		app: App,
		private plugin: FlashcardCorePlugin,
		private onChoose: (deck: string | undefined) => void,
		options: DeckPickerOptions = {},
	) {
		super(app);
		this.options = options;
		this.setPlaceholder(options.placeholder ?? "Review which deck?");
	}

	getItems(): DeckChoice[] {
		const decks = this.plugin.api.listDecks().map<DeckChoice>((deck) => {
			// Search on both: the pretty name is what the user thinks in, the id
			// is what they typed into a code block.
			const { name } = this.plugin.decks.resolve(deck);
			return {
				deck,
				label: name === deck ? deck : `${name}  (${deck})`,
				stats: this.plugin.api.getDeckStats(deck),
			};
		});
		if (this.options.includeAll === false) return decks;
		const all: DeckChoice = { deck: "", label: "All decks", stats: null };
		return [all, ...decks];
	}

	getItemText(choice: DeckChoice): string {
		if (!choice.stats) return choice.label;
		const { due_now, new_remaining } = choice.stats;
		return `${choice.label}  —  ${due_now} due, ${finite(new_remaining)} new`;
	}

	onChooseItem(choice: DeckChoice): void {
		this.onChoose(choice.deck === "" ? undefined : choice.deck);
	}
}

function finite(n: number): string {
	return Number.isFinite(n) ? String(n) : "∞";
}
