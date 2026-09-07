/**
 * Plugin-level settings and the settings tab.
 *
 * Note the split: *plugin* settings (where cards live, UI preferences) and the
 * collection-wide deck defaults are here in `data.json`; a *deck's own*
 * settings live in its `flashcard-core-deck.md` note, so they travel with the
 * collection and are editable in Obsidian itself.
 */

import { Notice, PluginSettingTab, Setting, type App, type ButtonComponent } from "obsidian";

import type { GlobalDeckSettings } from "../types";
import type { DailyRecord } from "./daily";
import { DEFAULT_GLOBAL, folderForCards } from "./deck-notes";
import { DEFAULT_SESSION_CONFIG, MAX_SESSION_RETRIES } from "./session";
import {
	bindingFromEvent,
	DEFAULT_HOTKEYS,
	displayHotkey,
	findConflicts,
	isModifierKey,
	REVIEW_ACTIONS,
	withDefaults,
	type ReviewActionId,
} from "./hotkeys";
import type FlashcardCorePlugin from "../main";

export interface FlashcardCoreSettings {
	/** Folder new card notes and their media are written into. */
	root: string;
	/** Play the first audio embed automatically when a side is shown. */
	autoplayAudio: boolean;
	/** Show predicted intervals on the grade buttons. */
	showIntervals: boolean;
	/** Cards between a card graded Again and its return, doubling per retry. 0 disables. */
	againGap: number;
	/** Unseen cards allowed in flight at once. 0 means no batching. */
	newBatchSize: number;
	/** Review-modal key bindings, keyed by action. Empty string means unbound. */
	hotkeys: Record<ReviewActionId, string>;
	/**
	 * Collection-wide deck caps and defaults.
	 *
	 * These live here rather than in the vault because they are not any one
	 * deck's business, and because a config file under the card folder goes
	 * missing the moment that folder is renamed.
	 */
	deckGlobals: GlobalDeckSettings;
	/** Today's counters. Persisted here so they survive a restart. */
	daily?: DailyRecord;
}

export const DEFAULT_SETTINGS: FlashcardCoreSettings = {
	root: "flashcards",
	autoplayAudio: true,
	showIntervals: true,
	againGap: DEFAULT_SESSION_CONFIG.againGap,
	newBatchSize: DEFAULT_SESSION_CONFIG.newBatchSize,
	hotkeys: { ...DEFAULT_HOTKEYS },
	deckGlobals: structuredClone(DEFAULT_GLOBAL),
};

export class FlashcardCoreSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: FlashcardCorePlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Card folder")
			.setDesc(
				"Root folder for decks. Each deck is a subfolder; card notes and their media live together inside it.",
			)
			.addText((text) =>
				text
					.setPlaceholder("flashcards")
					.setValue(this.plugin.settings.root)
					.onChange(async (value) => {
						this.plugin.settings.root = value.trim().replace(/^\/+|\/+$/g, "") || "flashcards";
						await this.plugin.saveSettings();
						await this.plugin.applyRoot();
					}),
			);

		new Setting(containerEl).setName("Review").setHeading();

		new Setting(containerEl)
			.setName("Autoplay audio")
			.setDesc("Play the first audio embed as soon as a side is revealed.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoplayAudio).onChange(async (value) => {
					this.plugin.settings.autoplayAudio = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Show predicted intervals")
			.setDesc("Label each grade button with when the card would next come up.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showIntervals).onChange(async (value) => {
					this.plugin.settings.showIntervals = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Bring back cards graded Again")
			.setDesc(
				`How many cards to put between a card you got wrong and its return, doubling each time it comes back (up to ${MAX_SESSION_RETRIES} returns). Set to 0 to run straight through the queue instead.`,
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SESSION_CONFIG.againGap))
					.setValue(String(this.plugin.settings.againGap))
					.onChange(async (value) => {
						const parsed = parseCount(value);
						if (parsed === null) return;
						this.plugin.settings.againGap = parsed;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("New cards per batch")
			.setDesc(
				"How many unseen cards to work on at once. A new card is only introduced once one already in the batch has been recalled — graded anything but Again. Set to 0 to introduce every new card the daily limit allows.",
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SESSION_CONFIG.newBatchSize))
					.setValue(String(this.plugin.settings.newBatchSize))
					.onChange(async (value) => {
						const parsed = parseCount(value);
						if (parsed === null) return;
						this.plugin.settings.newBatchSize = parsed;
						await this.plugin.saveSettings();
					}),
			);

		this.displayHotkeys(containerEl);

		new Setting(containerEl).setName("Decks").setHeading();

		const global = this.plugin.decks.global();

		containerEl.createEl("p", {
			cls: "fc-settings-summary",
			text:
				"A deck is a folder holding a flashcard-core-deck.md note, and that note's " +
				"frontmatter holds the deck's limits. Open a deck below to change them; the " +
				"values here apply to any field a deck note leaves unset.",
		});

		new Setting(containerEl)
			.setName("Global new-card cap")
			.setDesc("Maximum introductions per day across all decks. Leave empty for no cap.")
			.addText((text) =>
				text
					.setPlaceholder("no cap")
					.setValue(global.new_per_day_cap === null ? "" : String(global.new_per_day_cap))
					.onChange(async (value) => {
						const parsed = value.trim() === "" ? null : Number(value);
						if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return;
						await this.plugin.decks.setGlobal({ new_per_day_cap: parsed });
					}),
			);

		new Setting(containerEl)
			.setName("Global review cap")
			.setDesc("Maximum reviews per day across all decks. Leave empty for no cap.")
			.addText((text) =>
				text
					.setPlaceholder("no cap")
					.setValue(global.reviews_per_day_cap === null ? "" : String(global.reviews_per_day_cap))
					.onChange(async (value) => {
						const parsed = value.trim() === "" ? null : Number(value);
						if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return;
						await this.plugin.decks.setGlobal({ reviews_per_day_cap: parsed });
					}),
			);

		new Setting(containerEl)
			.setName("Day starts at")
			.setDesc("Hour the review day rolls over, so a late-night session counts as one day.")
			.addDropdown((drop) => {
				for (let h = 0; h < 24; h++) drop.addOption(String(h), `${String(h).padStart(2, "0")}:00`);
				drop.setValue(String(global.day_start_hour)).onChange(async (value) => {
					const hour = Number(value);
					await this.plugin.decks.setGlobal({ day_start_hour: hour });
					this.plugin.ledger.setDayStartHour(hour);
				});
			});

		new Setting(containerEl)
			.setName("Default new cards per day")
			.setDesc("Used by any deck whose note leaves new_per_day unset.")
			.addText((text) =>
				text.setValue(String(global.defaults.new_per_day)).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed < 0) return;
					await this.plugin.decks.setGlobal({
						defaults: { ...this.plugin.decks.global().defaults, new_per_day: parsed },
					});
				}),
			);

		new Setting(containerEl)
			.setName("Default reviews per day")
			.setDesc("Used by any deck whose note leaves max_reviews_per_day unset.")
			.addText((text) =>
				text.setValue(String(global.defaults.max_reviews_per_day)).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed < 0) return;
					await this.plugin.decks.setGlobal({
						defaults: { ...this.plugin.decks.global().defaults, max_reviews_per_day: parsed },
					});
				}),
			);

		this.displayDeckList(containerEl);

		new Setting(containerEl).setName("Today").setHeading();

		const record = this.plugin.ledger.current();
		const summary = containerEl.createDiv({ cls: "fc-settings-summary" });
		summary.createEl("p", {
			text: `Review day ${record.day}: ${record.introduced_total} introduced, ${record.reviews_total} reviewed.`,
		});

		new Setting(containerEl)
			.setName("Reset today's counters")
			.setDesc("Clears introduction and review counts for the current review day.")
			.addButton((button) =>
				button
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						await this.plugin.ledger.reset();
						this.display();
					}),
			);
	}

	// -- deck list ----------------------------------------------------------

	/**
	 * One row per deck, linking to the note that configures it.
	 *
	 * Limits are deliberately *not* editable here. A deck's knobs belong in its
	 * own note next to its cards, and duplicating them in two places is how
	 * they end up disagreeing. What this list is for is finding a deck, and
	 * spotting a deck that has cards but no note to configure them with.
	 */
	private displayDeckList(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Your decks").setHeading();

		const decks = this.plugin.api.listDecks();
		if (decks.length === 0) {
			containerEl.createEl("p", {
				cls: "fc-settings-summary",
				text: "No decks yet. One appears here as soon as a card or a deck note exists.",
			});
			return;
		}

		for (const deck of decks) {
			const config = this.plugin.decks.resolve(deck);
			const cards = this.plugin.store.inDeck(deck).length;
			const setting = new Setting(containerEl).setClass("fc-deck-row");

			setting.setName(config.registered ? config.name : deck);
			setting.setDesc(
				config.registered
					? `${deck} · ${cards} cards · ${config.new_per_day} new/day, ${config.max_reviews_per_day} reviews/day` +
							(config.enabled ? "" : " · disabled")
					: `${deck} · ${cards} cards · ⚠ no deck note, so it is using the defaults above`,
			);

			if (config.registered && config.path !== null) {
				const path = config.path;
				setting.addButton((button) =>
					button
						.setButtonText("Open")
						.setTooltip(path)
						.onClick(() => {
							void this.app.workspace.openLinkText(path, "", false);
						}),
				);
			} else {
				setting.addButton((button) =>
					button
						.setButtonText("Create deck note")
						.setCta()
						.onClick(() => void this.createDeckNote(deck)),
				);
			}
		}
	}

	/**
	 * Register an unconfigured deck, guessing its folder from where its cards
	 * already sit so the note lands next to them.
	 */
	private async createDeckNote(deck: string): Promise<void> {
		const cards = this.plugin.store.inDeck(deck);
		const folder = folderForCards(cards.map((card) => card.path));
		if (folder === null) {
			new Notice(`"${deck}" has no cards, so there is no folder to put its note in.`);
			return;
		}
		try {
			const note = await this.plugin.api.createDeckNote(folder, deck);
			new Notice(`Created ${note.path}`);
			this.display();
		} catch (err) {
			new Notice(`Could not create the deck note: ${String(err)}`);
		}
	}

	// -- hotkeys ------------------------------------------------------------

	/** Live key-capture listener, if a binding is being recorded right now. */
	private capturing: ((evt: KeyboardEvent) => void) | null = null;

	hide(): void {
		this.stopCapture();
	}

	private displayHotkeys(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Review hotkeys").setHeading();

		containerEl.createEl("p", {
			cls: "fc-settings-summary",
			text:
				"These apply inside the review modal only. Obsidian's own Hotkeys pane cannot bind " +
				"them, because they have to mean different things before and after the answer is " +
				"revealed. Click a key, then press the one you want; Backspace clears it.",
		});

		const hotkeys = withDefaults(this.plugin.settings.hotkeys);
		const conflicts = findConflicts(hotkeys);

		for (const action of REVIEW_ACTIONS) {
			const binding = hotkeys[action.id];
			const clashes = conflicts.get(binding.trim().toLowerCase()) ?? [];
			const others = clashes
				.filter((id) => id !== action.id)
				.map((id) => labelFor(id));

			const setting = new Setting(containerEl).setName(action.name);
			setting.setDesc(
				others.length > 0 ? `${action.desc}  ⚠ Also bound to: ${others.join(", ")}.` : action.desc,
			);

			setting.addButton((button) => {
				button.setButtonText(displayHotkey(binding));
				button.setTooltip("Click, then press the key you want");
				button.onClick(() => this.startCapture(action.id, button));
			});

			setting.addExtraButton((button) =>
				button
					.setIcon("rotate-ccw")
					.setTooltip(`Reset to ${displayHotkey(DEFAULT_HOTKEYS[action.id])}`)
					.onClick(async () => {
						this.plugin.settings.hotkeys = {
							...withDefaults(this.plugin.settings.hotkeys),
							[action.id]: DEFAULT_HOTKEYS[action.id],
						};
						await this.plugin.saveSettings();
						this.display();
					}),
			);
		}

		new Setting(containerEl)
			.setName("Reset all hotkeys")
			.setDesc("Restores every review key to its default.")
			.addButton((button) =>
				button.setButtonText("Reset all").onClick(async () => {
					this.plugin.settings.hotkeys = { ...DEFAULT_HOTKEYS };
					await this.plugin.saveSettings();
					this.display();
				}),
			);
	}

	/**
	 * Record the next keypress as this action's binding.
	 *
	 * Listened for on the document in the capture phase so the keystroke never
	 * reaches Obsidian's own shortcut handling — otherwise binding something
	 * like Ctrl+P would open the command palette instead of being recorded.
	 */
	private startCapture(actionId: ReviewActionId, button: ButtonComponent): void {
		this.stopCapture();
		button.setButtonText("Press a key…");
		button.setCta();

		const onKey = (evt: KeyboardEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			// Wait for a real key; a bare Shift is not a binding.
			if (isModifierKey(evt.key)) return;

			this.stopCapture();
			if (evt.key === "Escape") {
				this.display();
				return;
			}

			const cleared = evt.key === "Backspace" || evt.key === "Delete";
			const binding = cleared ? "" : bindingFromEvent(evt);
			this.plugin.settings.hotkeys = {
				...withDefaults(this.plugin.settings.hotkeys),
				[actionId]: binding,
			};
			void this.plugin.saveSettings().then(() => {
				this.display();
				if (cleared) new Notice(`flashcard-core: ${labelFor(actionId)} is now unbound.`);
			});
		};

		this.capturing = onKey;
		document.addEventListener("keydown", onKey, true);
	}

	private stopCapture(): void {
		if (!this.capturing) return;
		document.removeEventListener("keydown", this.capturing, true);
		this.capturing = null;
	}
}

/** A non-negative whole number, or `null` for anything we should not save. */
function parseCount(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return Math.floor(parsed);
}

function labelFor(actionId: ReviewActionId): string {
	return REVIEW_ACTIONS.find((a) => a.id === actionId)?.name ?? actionId;
}

