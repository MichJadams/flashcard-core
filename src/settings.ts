/**
 * Plugin-level settings and the settings tab.
 *
 * Note the split: *plugin* settings (where cards live, UI preferences) are here
 * in `data.json`; *deck* settings (limits, FSRS tuning) live in the vault's
 * `_decks.json` so they travel with the collection and can be edited by hand or
 * by a generator.
 */

import { Notice, PluginSettingTab, Setting, type App, type ButtonComponent } from "obsidian";

import type { DailyRecord } from "./daily";
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
	/** Folder that holds deck folders, card notes, media, and `_decks.json`. */
	root: string;
	/** Play the first audio embed automatically when a side is shown. */
	autoplayAudio: boolean;
	/** Show predicted intervals on the grade buttons. */
	showIntervals: boolean;
	/** Review-modal key bindings, keyed by action. Empty string means unbound. */
	hotkeys: Record<ReviewActionId, string>;
	/** Today's counters. Persisted here so they survive a restart. */
	daily?: DailyRecord;
}

export const DEFAULT_SETTINGS: FlashcardCoreSettings = {
	root: "flashcards",
	autoplayAudio: true,
	showIntervals: true,
	hotkeys: { ...DEFAULT_HOTKEYS },
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

		this.displayHotkeys(containerEl);

		new Setting(containerEl).setName("Decks").setHeading();

		const global = this.plugin.decks.global();

		new Setting(containerEl)
			.setName("Deck configuration file")
			.setDesc(
				`Per-deck limits and FSRS parameters live in ${this.plugin.decks.filePath}. Edit it directly, or call setDeckConfig from a generator plugin.`,
			)
			.addButton((button) =>
				button.setButtonText("Reload").onClick(async () => {
					await this.plugin.decks.load();
					this.plugin.scheduler.invalidate();
					this.display();
				}),
			);

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
			.setDesc("Used by any deck that does not set its own limit and has no configured parent.")
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
			.setDesc("Used by any deck that does not set its own limit and has no configured parent.")
			.addText((text) =>
				text.setValue(String(global.defaults.max_reviews_per_day)).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed < 0) return;
					await this.plugin.decks.setGlobal({
						defaults: { ...this.plugin.decks.global().defaults, max_reviews_per_day: parsed },
					});
				}),
			);

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

function labelFor(actionId: ReviewActionId): string {
	return REVIEW_ACTIONS.find((a) => a.id === actionId)?.name ?? actionId;
}
