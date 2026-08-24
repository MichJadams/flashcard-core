# Example: a generator plugin

A minimal Obsidian plugin — call it **Blossom** — that teaches note reading on
the treble staff. It owns the subject matter; Flashcard Core owns everything
else.

## 1. Depend on the contract

`types.ts` has no runtime dependencies, so either point your `tsconfig` at it or
copy it into your source tree.

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "flashcard-core/types": ["../flashcard-core/types.ts"]
    }
  }
}
```

## 2. Get the API

```ts
// src/core.ts
import { Notice, type App } from "obsidian";
import type { FlashcardCoreAPI } from "flashcard-core/types";

export function getCore(app: App): FlashcardCoreAPI | null {
  const plugin = (app as any).plugins?.getPlugin("flashcard-core");
  if (!plugin?.api) {
    new Notice("Blossom needs the Flashcard Core plugin to be installed and enabled.");
    return null;
  }
  const api = plugin.api as FlashcardCoreAPI;
  if (!api.schemaVersion.startsWith("1.")) {
    new Notice(`Flashcard Core speaks schema ${api.schemaVersion}; Blossom expects 1.x.`);
    return null;
  }
  return api;
}
```

## 3. Build the deck

Ids are deterministic and namespaced. `new_order` is spaced by 100 so future
cards can slot between existing ones without renumbering. Each note is gated
behind the one before it, so the learner meets them in order regardless of how
many new cards a day they have configured.

```ts
// src/deck.ts
import type { CardSpec, IngestSpec } from "flashcard-core/types";

const DECK = "piano/note-reading";
const PLUGIN = "blossom";

const TREBLE = [
  { key: "c4", label: "C (below the staff)" },
  { key: "e4", label: "E (bottom line)" },
  { key: "g4", label: "G (second line)" },
  { key: "b4", label: "B (middle line)" },
  { key: "c5", label: "C (third space)" },
];

export function buildDeck(): IngestSpec {
  const cards: CardSpec[] = TREBLE.map((note, i) => ({
    id: `${PLUGIN}:note-reading:${note.key}-treble`,
    deck: DECK,
    template: "audio",
    tags: ["treble", "note-reading"],

    // Floats, spaced out: insert 150 later without touching anything else.
    new_order: (i + 1) * 100,

    // Each note waits for the previous one to be genuinely learned.
    prerequisites: i === 0 ? [] : [`${PLUGIN}:note-reading:${TREBLE[i - 1].key}-treble`],
    gate: { min_stability: 5.0 },

    fields: {
      front: "What note is this?",
      front_image: `treble-${note.key}.png`,   // resolved inside the deck folder
      back: note.label,
      back_audio: `${note.key}.mp3`,
      extra: "Say the letter aloud before checking.",
    },
  }));

  return {
    schema_version: "1.0",
    source_plugin: PLUGIN,
    cards,
    options: {
      // This document is the whole truth for the deck: anything of ours that is
      // no longer listed gets removed. Drop this for incremental updates.
      prune_decks: [DECK],
    },
  };
}
```

Copy `treble-c4.png`, `c4.mp3`, and friends into
`flashcards/piano/note-reading/` — ingestion writes the embeds, not the bytes.

## 4. Ingest, and set the deck's limits once

```ts
// main.ts
import { Notice, Plugin } from "obsidian";
import { getCore } from "./src/core";
import { buildDeck } from "./src/deck";

export default class BlossomPlugin extends Plugin {
  private unregisterOrder?: () => void;

  async onload() {
    this.addCommand({
      id: "generate-note-reading",
      name: "Generate the note-reading deck",
      callback: () => void this.generate(),
    });

    this.app.workspace.onLayoutReady(() => this.installOrderProvider());
  }

  onunload() {
    this.unregisterOrder?.();
  }

  private async generate() {
    const core = getCore(this.app);
    if (!core) return;

    // Safe to run on every launch: unchanged cards are not even written, and
    // changed cards keep their entire review history.
    const result = await core.upsertCards(buildDeck());

    if (result.errors.length > 0) {
      console.error("[blossom] ingestion errors", result.errors);
      new Notice(`Blossom: ${result.errors.length} card(s) rejected — see the console.`);
    }
    new Notice(
      `Blossom: ${result.created.length} new, ${result.updated.length} updated, ` +
        `${result.unchanged.length} unchanged, ${result.pruned.length} removed.`,
    );

    // Opinionated first-run defaults. Only write them if the user has not
    // configured the deck themselves.
    if (!core.getRawDeckConfig("piano/note-reading")) {
      await core.setDeckConfig("piano/note-reading", {
        new_per_day: 3,
        max_reviews_per_day: 60,
        fsrs_params: { request_retention: 0.9, learning_steps: ["1m", "10m"] },
      });
    }
  }

  /**
   * Optional. Without this, the core introduces cards by `new_order` ascending,
   * which is already the right answer most of the time.
   */
  private installOrderProvider() {
    const core = getCore(this.app);
    if (!core) return;

    this.unregisterOrder = core.registerNewCardOrderProvider({
      id: "blossom:note-reading",
      deck: "piano/note-reading",

      provide({ candidates, all_cards }) {
        // Do not pile on new material while old material is falling over.
        const struggling = all_cards.filter(
          (c) => c.deck.startsWith("piano/note-reading") && c.fsrs.state === "relearning",
        ).length;
        if (struggling >= 3) return [];   // withhold everything today

        // `candidates` arrives eligibility-filtered and already sorted by
        // new_order, so the default order is just this:
        return candidates.map((c) => c.id);
      },
    });
  }
}
```

## 5. Kick off a review (optional)

```ts
await core.startReview("piano/note-reading");
```

Or react to grades — for a streak counter, a progress note, anything:

```ts
this.register(
  core.onReview(({ card, rating, introduced }) => {
    if (introduced) console.log(`[blossom] introduced ${card.id}`);
    if (rating === 1) console.log(`[blossom] lapsed: ${card.id}`);
  }),
);
```

---

## What Blossom does not do

- **Touch `fsrs_*` frontmatter.** Ever. The core owns scheduling.
- **Enforce its own daily limits.** `provide()` can withhold cards, but the
  numbers live in `_decks.json` where the user can see and change them.
- **Build a browse UI.** The user filters and sorts in Bases.
- **Delete cards on its own.** `prune_decks` is scoped to
  `source_plugin: "blossom"`, so another plugin's cards in the same deck are
  never touched.

## Emitting JSON instead

Everything above works from a plain JSON file too — useful if the cards are
authored elsewhere, or generated by a script rather than by a plugin.

```ts
const raw = await this.app.vault.adapter.read("blossom/deck.json");
const result = await core.upsertCards(JSON.parse(raw));
```

The document is exactly the schema in the README. `upsertCards` validates the
envelope and every card, so an unparsable or half-written file yields a list of
errors rather than a corrupted collection.
