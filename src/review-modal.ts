/**
 * The review modal.
 *
 * Browsing, filtering, and managing the collection are Bases' job; the
 * frontmatter is designed for exactly that. What Bases cannot do is show one
 * card at a time, hide the answer, and grade it — that lives in `ReviewView`,
 * which this class does nothing but host. Everything here is modal plumbing:
 * the window, the key scope, and the close button.
 */

import { Modal, type App } from "obsidian";

import type { QueueItem } from "../types";
import { ReviewView } from "./review-view";
import type FlashcardCorePlugin from "../main";

export { hasAudio } from "./review-view";

export class ReviewModal extends Modal {
	private view: ReviewView;

	constructor(
		app: App,
		plugin: FlashcardCorePlugin,
		queue: QueueItem[],
		deck: string | undefined,
	) {
		super(app);
		this.view = new ReviewView(app, plugin, this.contentEl, deck, queue, {
			// A modal owns a key scope for exactly as long as it is open, which
			// is the whole reason grading keys are safe to bind bare here.
			bindKey: (hotkey, run) => {
				this.scope.register(hotkey.modifiers, hotkey.key, (evt) => {
					evt.preventDefault();
					run();
					return false;
				});
			},
			close: () => this.close(),
		});
	}

	onOpen(): void {
		this.modalEl.addClass("fc-review-modal");
		this.view.mount();
	}

	onClose(): void {
		this.view.unmount();
	}
}
