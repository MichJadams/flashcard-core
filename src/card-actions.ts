/**
 * A scheduling panel on every card note: what the card's state is, and a
 * button to reset it.
 *
 * Injected by a post-processor rather than a code block in the note body. Card
 * bodies are generator-owned and rewritten on every regeneration, so a block
 * added to them would not survive — and back-filling one into a collection
 * that already has hundreds of cards is not a migration worth running.
 *
 * The reset goes through the same `forgetCard` path as the command, so it
 * clears every `fsrs_*` field via FSRS's own `forget()` rather than flipping
 * `fsrs_state` and leaving stale reps, lapses, and stability behind.
 */

import { ButtonComponent, Notice } from "obsidian";

import type { CardRecord } from "../types";
import type FlashcardCorePlugin from "../main";

/** `true` when a card has no scheduling history left to clear. */
function isFresh(card: CardRecord): boolean {
	return card.fsrs.state === "new" && card.fsrs.reps === 0;
}

export function registerCardActions(plugin: FlashcardCorePlugin): void {
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		const card = plugin.store.getByPath(ctx.sourcePath);
		if (!card) return;

		// A note renders as many sections; the panel belongs to the note, so it
		// goes into the shared container, once.
		const host = el.closest(".markdown-preview-section");
		if (!(host instanceof HTMLElement)) return;
		if (host.querySelector(".fc-card-actions")) return;

		host.prepend(buildPanel(plugin, card.id));
	});

	// Reading view is where that panel renders. The menu covers everywhere
	// else: editing view, the file explorer, and a row in a Base.
	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu, file) => {
			const card = plugin.store.getByPath(file.path);
			if (!card) return;
			menu.addItem((item) =>
				item
					.setTitle("Reset card to new")
					.setIcon("rotate-ccw")
					.setDisabled(isFresh(card))
					.onClick(() => void reset(plugin, card.id)),
			);
		}),
	);
}

/**
 * The panel, which re-reads the card on every draw.
 *
 * Holding the id rather than the record matters: after a reset the record is a
 * new object, and a stale copy would leave the summary claiming history the
 * note no longer has.
 */
function buildPanel(plugin: FlashcardCorePlugin, id: string): HTMLElement {
	const panel = document.createElement("div");
	panel.className = "fc-card-actions";

	const draw = () => {
		panel.empty();
		const card = plugin.store.get(id);
		if (!card) {
			panel.createSpan({ cls: "fc-card-actions-summary", text: "Card not indexed." });
			return;
		}

		const { fsrs } = card;
		const deck = plugin.decks.resolve(card.deck).name;
		panel.createSpan({
			cls: "fc-card-actions-summary",
			text: isFresh(card)
				? `${deck} · new, never reviewed`
				: `${deck} · ${fsrs.state} · ${fsrs.reps} reps, ${fsrs.lapses} lapses · due ${fsrs.due.slice(0, 10)}`,
		});

		const button = new ButtonComponent(panel).setButtonText("Reset card to new");
		if (isFresh(card)) {
			button.setDisabled(true).setTooltip("Nothing to reset — this card has no history");
			return;
		}
		button.setTooltip("Clears every fsrs_ field through FSRS, not just fsrs_state");
		button.onClick(async () => {
			button.setDisabled(true);
			await reset(plugin, id);
			draw();
		});
	};

	draw();
	return panel;
}

/** Shared by the button and the menu item, so the two cannot drift apart. */
async function reset(plugin: FlashcardCorePlugin, id: string): Promise<boolean> {
	try {
		await plugin.api.forgetCard(id);
		new Notice(`Reset ${id} to new.`);
		return true;
	} catch (err) {
		new Notice(`Could not reset the card: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}
