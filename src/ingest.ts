/**
 * JSON ingestion — the primary integration path.
 *
 * Validation is per-card and non-fatal: one malformed card is reported in
 * {@link IngestResult.errors} while every valid card in the same document still
 * lands. A generator that emits 400 cards and gets one wrong should not lose
 * the other 399.
 */

import type {
	CardSpec,
	FsrsState,
	IngestError,
	IngestResult,
	IngestSpec,
} from "../types";
import { SCHEMA_VERSION } from "../types";
import { deckMatches, normaliseDeck } from "./note";
import type { CardStore } from "./store";

/** Semver-ish major-version check: `1.x` documents are accepted by a `1.0` build. */
function schemaCompatible(version: string): boolean {
	const [major] = String(version).split(".");
	const [ours] = SCHEMA_VERSION.split(".");
	return major === ours;
}

/**
 * Validate a single card. Returns an error message, or `null` if the card is
 * usable. Unknown extra keys are allowed — forward compatibility matters more
 * than strictness here.
 */
export function validateCard(card: unknown, index: number): { spec: CardSpec } | { error: IngestError } {
	const at = `cards[${index}]`;
	if (!card || typeof card !== "object" || Array.isArray(card)) {
		return { error: { id: null, message: `${at}: expected an object` } };
	}
	const c = card as Record<string, unknown>;
	const id = c["id"];
	if (typeof id !== "string" || id.trim().length === 0) {
		return { error: { id: null, message: `${at}: "id" must be a non-empty string` } };
	}
	if (!id.includes(":")) {
		return {
			error: {
				id,
				message: `"id" must be namespaced as plugin:deck:key so ids from different generators cannot collide`,
			},
		};
	}
	const deck = c["deck"];
	if (typeof deck !== "string" || normaliseDeck(deck).length === 0) {
		return { error: { id, message: `"deck" must be a non-empty slash-delimited path` } };
	}
	const fields = c["fields"];
	if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
		return { error: { id, message: `"fields" must be an object` } };
	}
	const f = fields as Record<string, unknown>;
	if (typeof f["front"] !== "string" || (f["front"] as string).trim().length === 0) {
		return { error: { id, message: `"fields.front" must be a non-empty string` } };
	}
	if (typeof f["back"] !== "string") {
		return { error: { id, message: `"fields.back" must be a string` } };
	}
	const newOrder = c["new_order"];
	if (newOrder !== undefined && (typeof newOrder !== "number" || !Number.isFinite(newOrder))) {
		return { error: { id, message: `"new_order" must be a finite number` } };
	}
	const prerequisites = c["prerequisites"];
	if (prerequisites !== undefined) {
		if (!Array.isArray(prerequisites) || prerequisites.some((p) => typeof p !== "string")) {
			return { error: { id, message: `"prerequisites" must be an array of card ids` } };
		}
		if ((prerequisites as string[]).includes(id)) {
			return { error: { id, message: `a card cannot be its own prerequisite` } };
		}
	}
	return { spec: card as CardSpec };
}

/** Validate the document envelope. Returns a message, or `null` if it is usable. */
export function validateSpec(spec: unknown): string | null {
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "expected a JSON object";
	const s = spec as Record<string, unknown>;
	if (typeof s["schema_version"] !== "string") return `"schema_version" is required`;
	if (!schemaCompatible(s["schema_version"] as string)) {
		return `unsupported schema_version "${s["schema_version"]}"; this build speaks ${SCHEMA_VERSION}`;
	}
	if (typeof s["source_plugin"] !== "string" || (s["source_plugin"] as string).trim().length === 0) {
		return `"source_plugin" must be a non-empty string`;
	}
	if (!Array.isArray(s["cards"])) return `"cards" must be an array`;
	return null;
}

/** Run an ingestion document against the store. */
export async function ingest(
	store: CardStore,
	spec: IngestSpec,
	freshState: () => FsrsState,
): Promise<IngestResult> {
	const result: IngestResult = {
		created: [],
		updated: [],
		unchanged: [],
		pruned: [],
		errors: [],
	};

	const envelopeError = validateSpec(spec);
	if (envelopeError) {
		result.errors.push({ id: null, message: envelopeError });
		return result;
	}

	const defaultRegenerate = spec.options?.regenerate_on_change ?? true;
	const seen = new Set<string>();
	const accepted: CardSpec[] = [];

	for (let i = 0; i < spec.cards.length; i++) {
		const checked = validateCard(spec.cards[i], i);
		if ("error" in checked) {
			result.errors.push(checked.error);
			continue;
		}
		if (seen.has(checked.spec.id)) {
			result.errors.push({
				id: checked.spec.id,
				message: `duplicate id within this document; only the first occurrence was ingested`,
			});
			continue;
		}
		seen.add(checked.spec.id);
		accepted.push(checked.spec);
	}

	for (const card of accepted) {
		const regenerate = card.options?.regenerate_on_change ?? defaultRegenerate;
		try {
			const outcome = await store.upsert(card, spec.source_plugin, regenerate, freshState);
			result[outcome].push(card.id);
		} catch (err) {
			result.errors.push({ id: card.id, message: `write failed: ${describe(err)}` });
		}
	}

	// Pruning runs last so a card that moved between decks within this same
	// document is never deleted after being written.
	const pruneDecks = spec.options?.prune_decks ?? [];
	if (pruneDecks.length > 0) {
		const stale = store
			.all()
			.filter(
				(card) =>
					card.source_plugin === spec.source_plugin &&
					!seen.has(card.id) &&
					pruneDecks.some((deck) => deckMatches(card.deck, deck)),
			)
			.map((card) => card.id);
		if (stale.length > 0) {
			await store.remove(stale);
			result.pruned.push(...stale);
		}
	}

	return result;
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
