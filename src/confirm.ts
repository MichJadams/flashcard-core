/**
 * A yes/no modal, awaited.
 *
 * Obsidian ships no confirmation primitive, and the destructive commands here
 * need one — dismissing the dialog any other way (Escape, clicking away) has
 * to mean "no", which a bare callback makes easy to get wrong.
 */

import { Modal, Setting, type App } from "obsidian";

export interface ConfirmOptions {
	title: string;
	body: string;
	/** Label for the destructive button. */
	cta: string;
}

export function confirm(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, options, resolve).open();
	});
}

class ConfirmModal extends Modal {
	/** Guards against resolving twice when the button also triggers onClose. */
	private answered = false;

	constructor(
		app: App,
		private options: ConfirmOptions,
		private respond: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.options.title);
		this.contentEl.createEl("p", { text: this.options.body });

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.finish(false)),
			)
			.addButton((button) =>
				button
					.setButtonText(this.options.cta)
					.setWarning()
					.onClick(() => this.finish(true)),
			);
	}

	onClose(): void {
		// Escape, or clicking outside: the safe answer.
		this.finish(false);
	}

	private finish(ok: boolean): void {
		if (this.answered) return;
		this.answered = true;
		this.respond(ok);
		this.close();
	}
}
