# Flashcard Core

A generic, FSRS-backed flashcard engine for Obsidian.

It knows nothing about any subject. Other plugins — a piano trainer, a language
tutor, whatever you write — generate the cards; this plugin owns **scheduling,
storage, deck limits, and review**. If you are writing one of those generator
plugins, this document is for you.

Scheduling is [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)
(v5.4.x), wrapped in `src/scheduler.ts`. Nothing else in the codebase imports it,
and nothing in the public contract exposes it, so the library is an
implementation detail you never depend on.

---

## Contents

- [The shape of the thing](#the-shape-of-the-thing)
- [Card notes](#card-notes)
- [JSON ingestion schema](#json-ingestion-schema)
- [Ingestion rules](#ingestion-rules)
- [New-card ordering](#new-card-ordering)
- [Session pacing](#session-pacing)
- [Deck configuration](#deck-configuration)
- [Programmatic API](#programmatic-api)
- [Browsing with Bases](#browsing-with-bases)
- [Reviewing in a note](#reviewing-in-a-note)
- [Commands](#commands)
- [Development](#development)

---

## The shape of the thing

Four decisions drive everything else:

1. **A card is a note.** One Markdown file per card, FSRS state in its
   frontmatter. No multi-card-per-note, no sidecar database. The vault is the
   database.
2. **Media lives beside the cards.** Audio and images sit in the same deck
   folder as the notes that reference them, embedded with ordinary `![[...]]`
   wikilinks, so they render in preview, in the review modal, and in Bases.
3. **Ingestion is upsert.** Regenerating a deck rewrites content and *never*
   touches scheduling history.
4. **There is no browse UI.** The frontmatter schema is designed for Obsidian
   Bases, which already does tables, grouping, filtering, and sorting better
   than a bespoke view would. This plugin builds exactly one screen: the
   reviewer.

```
flashcards/                          <- configurable root for new cards
├── Flashcards.base                  <- optional; created on demand
└── piano/
    └── note-reading/
        ├── flashcard-core-deck.md   <- makes this folder a deck
        ├── blossom__note-reading__c5-treble.md
        ├── treble-c5.png            <- media beside the card
        └── c5.mp3
```

---

## Card notes

```markdown
---
fc: card
id: blossom:note-reading:c5-treble
deck: piano/note-reading
source_plugin: blossom
template: audio
tags:
  - treble
fc_new_order: 1420
fc_prerequisites:
  - blossom:note-reading:d5-treble
fc_gate:
  min_stability: 5
fc_hash: 1k4mz9x2p0
fsrs_due: 2026-08-27T09:14:22.104Z
fsrs_stability: 6.4212
fsrs_difficulty: 5.0031
fsrs_reps: 3
fsrs_lapses: 0
fsrs_state: review
fsrs_last_review: 2026-08-23T09:14:22.104Z
fsrs_learning_steps: 0
fsrs_scheduled_days: 4
---

## Front

What note is this?

![[flashcards/piano/note-reading/treble-c5.png]]

## Back

C (third space)

![[flashcards/piano/note-reading/c5.mp3]]

## Extra

Ledger-line neighbours: B below, D above.
```

### Ownership of frontmatter

| Keys | Owner | Notes |
| --- | --- | --- |
| `fc`, `id`, `deck`, `source_plugin`, `template`, `tags`, `fc_new_order`, `fc_prerequisites`, `fc_gate` | your generator | rewritten on every regeneration |
| `fc_hash` | this plugin | content digest; lets an unchanged regeneration skip the write entirely |
| `fsrs_*` | this plugin | **never write these** |
| anything else | you or the user | preserved verbatim across regenerations |

`fc: card` and `deck` are the anchors. A Base filters on `fc == "card"` and
groups by `deck`; every other property is there to be a column.

### Body

`## Front`, `## Back`, and an optional `## Extra`. Heading matching is
case-insensitive, and a body with no headings at all is treated as front-only —
a hand-written card still reviews rather than throwing.

---

## JSON ingestion schema

The primary integration path. Build this object and hand it to
`upsertCards()`.

```json
{
  "schema_version": "1.0",
  "source_plugin": "blossom",
  "cards": [
    {
      "id": "blossom:note-reading:c5-treble",
      "deck": "piano/note-reading",
      "template": "audio",
      "tags": ["treble"],
      "new_order": 1420,
      "prerequisites": ["blossom:note-reading:d5-treble"],
      "gate": { "min_stability": 5.0 },
      "fields": {
        "front": "What note is this?",
        "front_image": "treble-c5.png",
        "back": "C (third space)",
        "back_audio": "c5.mp3"
      },
      "options": { "regenerate_on_change": true }
    }
  ],
  "options": {
    "regenerate_on_change": true,
    "prune_decks": ["piano/note-reading"]
  }
}
```

### Envelope

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schema_version` | string | yes | `"1.0"`. Any `1.x` is accepted; a `2.x` document is rejected. |
| `source_plugin` | string | yes | Your plugin's name. Written to each note and used for scoped deletion. |
| `cards` | array | yes | See below. |
| `options.regenerate_on_change` | boolean | no | Default for cards that do not set their own. Default `true`. |
| `options.prune_decks` | string[] | no | Decks this document is authoritative for. Existing cards of yours in those decks that are absent from `cards` get deleted. Omit for incremental updates. |

### Card

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | Stable, deterministic, namespaced `plugin:deck:key`. **Must contain a colon.** |
| `deck` | string | yes | Slash-delimited hierarchical path. |
| `template` | `basic` \| `cloze` \| `audio` \| `visual` | no | Rendering hint only; does not affect scheduling. Default `basic`. |
| `tags` | string[] | no | Written to the note's `tags`. |
| `new_order` | number (float) | no | Base sort key for introduction, ascending. Default `0`. |
| `prerequisites` | string[] | no | Card ids that gate this card. |
| `gate` | `{ min_stability?: number }` | no | Condition each prerequisite must meet. |
| `fields.front` | string | yes | Markdown. Must be non-empty. |
| `fields.back` | string | yes | Markdown. May be empty. |
| `fields.front_image`, `front_audio`, `back_image`, `back_audio` | string | no | Media file names. |
| `fields.extra` | string | no | Markdown for `## Extra`. |
| `fields.*` | string | no | Any other key renders as `**key:** value` under `## Extra`. |
| `options.regenerate_on_change` | boolean | no | `false` means "create if missing, then never touch again". |

### Media resolution

| You write | You get |
| --- | --- |
| `"c5.mp3"` | `![[flashcards/piano/note-reading/c5.mp3]]` — resolved against the card's own deck folder |
| `"shared/audio/c5.mp3"` | `![[shared/audio/c5.mp3]]` — anything containing `/` is vault-relative |
| `"![[c5.mp3]]"` | passed through untouched |

Copy the media files into the deck folder yourself; ingestion writes the embeds
but does not move bytes.

### Validation

Per-card and non-fatal. One malformed card lands in `result.errors`; every valid
card in the same document is still written. A generator that emits 400 cards and
gets one wrong should not lose the other 399.

```ts
const result = await core.upsertCards(spec);
// { created: [...], updated: [...], unchanged: [...], pruned: [...], errors: [...] }
if (result.errors.length) console.warn(result.errors);
```

---

## Ingestion rules

**Ids come from you and must be deterministic.** `plugin:deck:key`. The same
logical card must produce the same id on every run — that is the whole basis of
upsert. Change an id and you have created a different card with a fresh history.

**Upsert never resets scheduling.** If the id already exists, content and
generator-owned frontmatter are replaced; every `fsrs_*` field is carried
across untouched. This is the single most important invariant in the plugin. It
holds even when the deck, template, tags, and both faces all change at once.

**Unchanged regenerations are free.** `fc_hash` digests the generator-owned
frontmatter plus the rendered body. If it matches, the file is not written at
all — no modification time churn, no sync noise.

**Notes follow their deck.** Change a card's `deck` and the note is moved into
the new deck folder on the next ingestion.

**Deletion is explicit.** Three ways:

```ts
await core.deleteCards(["blossom:note-reading:c5-treble"]);   // by id
await core.deleteByDeck("piano/note-reading", "blossom");     // one deck, your cards only
await core.upsertCards({ ...spec, options: { prune_decks: ["piano/note-reading"] } });
```

`deleteByDeck` and `prune_decks` both filter on `source_plugin`, so another
plugin's cards sharing the same deck are never collateral damage. Deleted notes
go to the vault trash, per the user's trash setting.

---

## New-card ordering

Three layers, applied strictly in this order. Read this section before writing a
queue provider — the division of responsibility is the point.

### 1. Eligibility (the core decides)

A new card is a candidate only if **every** entry in `fc_prerequisites`:

- exists as a card, **and**
- satisfies `fc_gate`:
  - with `min_stability: N` — the prerequisite's `fsrs_stability >= N`
  - with no gate — the prerequisite has simply left the `new` state

A prerequisite that does not exist blocks the card indefinitely. That is
deliberate: during a partial generation run, withholding a card beats teaching
it out of order.

### 2. Order (you may decide)

If a queue provider is registered for the deck, the order it returns is used.
Otherwise: `fc_new_order` ascending, ties broken by id so the result is stable
across sessions and machines.

`fc_new_order` is a **float** on purpose. Emit `1000, 2000, 3000` and you can
later insert `1500` without renumbering the deck.

### 3. Limit (the core decides)

Take cards while budget remains. Budget is the minimum of:

- the deck's remaining `new_per_day`,
- the global `new_per_day_cap`.

Decks are flat. Introducing a card spends budget in exactly one deck and in the
collection-wide pool, so one deck can never quietly consume another's
allowance.

### Who counts what

**The core owns introduction accounting.** A card counts against the daily new
limit at the moment it is **first graded**, not when it enters a queue. Build a
queue and walk away and it has cost the learner nothing. Grading also flips the
card out of `new`, so it never re-enters the new queue.

A provider proposes an order. It cannot introduce a gated card, and it cannot
raise a limit.

### Writing a provider

```ts
import type { NewCardOrderProvider } from "flashcard-core/types";

const unregister = core.registerNewCardOrderProvider({
  id: "blossom:interleave",
  deck: "piano",            // governs piano and every deck beneath it; "" governs all

  provide({ deck, candidates, all_cards, limit, now }) {
    // `candidates` is already eligibility-filtered and sorted by fc_new_order.
    // `all_cards` is everything the core knows, including mature cards — use it
    // to reason about what the learner has actually consolidated.
    const shaky = all_cards.filter(c => c.fsrs.state === "relearning").length;
    if (shaky > 5) return [];             // withhold entirely today
    return candidates.map(c => c.id);
  },
});

// in your plugin's onunload:
unregister();
```

Contract details:

- Ids not in `candidates` are ignored; duplicates collapse.
- **Candidates you omit are not appended.** Omitting a card withholds it for
  today — a supported way to pace a deck. Return `[]` to introduce nothing.
- Return more than `limit` if convenient; the core truncates.
- Throwing falls back to `fc_new_order` and logs. It never breaks review.
- Registering an `id` that already exists replaces it.
- When several providers match a deck, the one with the **longest matching
  `deck` prefix** wins.

---

## Session pacing

The three layers above decide **which** cards a session may contain. Pacing is
the separate question of what order you actually meet them in, and it exists to
fix one failure: fifteen unknown cards in a row, none of them recalled, the end
of the queue reached without a single act of retrieval.

Two rules, both in `src/session.ts`, both configurable under **Settings →
Flashcard Core → Review**.

### Cards graded Again come back

A card you get wrong is put back into the session a few cards later instead of
being dropped until the next queue build. The gap **doubles** each time the card
comes back — 3, 6, 12, 24 with the default — so a card you keep missing is
drilled tightly at first and then given room to be genuinely recalled rather
than parroted.

After four returns the card leaves anyway. Its FSRS state is already written, so
a learning step brings it back through **Check for more**; and a card that has
resisted five attempts in three minutes is telling you it needs rewriting, not
another look.

Set **Bring back cards graded Again** to `0` to disable this and run straight
through the queue.

The gap counts the cards *in between*: with a gap of 3 you see three other cards
and then the one you missed.

### New cards arrive in batches

Only so many unseen cards are in flight at once — five by default. A held-back
card is admitted when one already in the batch is graded anything **other than
Again**, which is to say when you have recalled it once.

This is the rule that actually fixes the complaint. A gap alone still lets
fifteen unknown cards into the session; the batch means you are working on five
until five are known.

Set **New cards per batch** to `0` to introduce every new card the daily limit
allows, as before.

Due reviews are never held back — the batch counts unseen cards only, and a
review leaving the session does not free a slot.

### What pacing does not touch

Nothing here grades, writes, or schedules. Every card carries out of the session
exactly the FSRS state its grades produced, identical to what it would have been
had the cards been shown in build order. Pacing is ordering and nothing else.

Skipping a card drops it from the session rather than sending it back: a skip
says nothing about recall. It does free its batch slot, or a session of skips
would sit there holding cards back for no reason.

The header reads `7 left · deck · again ×2` — what remains rather than a
position, because a position out of a fixed total is a lie once cards return.

---

## Deck configuration

**A deck is a folder holding a `flashcard-core-deck.md` note.** That note's
frontmatter is the deck's config, which means it is editable in Obsidian
itself, next to the cards it governs, and it travels with the collection.

```yaml
---
fc: deck
id: deck-a1b2c3d
name: Note reading (treble)
new_per_day: 4
max_reviews_per_day: 200
enabled: true
fsrs_params:
  request_retention: 0.85
  learning_steps: ["1m", "10m"]
---

```flashcard-deck-stats
```

```flashcard-deck-settings
```
```

### Ids, names, and folders

Three separate things, deliberately:

- **`id`** is what ties cards to the deck. A card's `deck` field holds an id,
  never a folder path, so a deck folder can be renamed or moved without
  rewriting a single card.
- **`name`** is for display, and is the only part meant to be read or typed.
  It falls back to the id when unset.
- **the folder** is just where the note lives, and where new cards for the deck
  get written. `createDeckNote` and the settings tab put it beside the cards.

**Ids are opaque by convention: `deck-` plus seven lowercase alphanumerics**,
e.g. `deck-a1b2c3d`. Any string works — an id is never parsed — but an opaque
one keeps a rename from ever becoming a migration. Nothing is inherited between
decks whatever the id looks like.

Because an opaque id is no fun to type, everywhere a *person* names a deck
accepts either form: a `deck:` line in a code block takes the id or the display
name, and `resolveDeckRef(ref)` does the same for generators. Matching is
id-first, then name, case-insensitively.

A generator should call `resolveDeckRef("MSA vocabulary")` rather than
hard-coding `deck-a1b2c3d`, so the id stays an implementation detail.

### Per-deck fields

| Field | Meaning |
| --- | --- |
| `id` | **Required.** Stable deck id, matched against each card's `deck`. |
| `name` | Display title. Defaults to the id. |
| `new_per_day` | Cards introduced per day in this deck. |
| `max_reviews_per_day` | Non-new cards shown per day in this deck. |
| `enabled` | `false` removes the deck from queue building entirely. |
| `fsrs_params` | `request_retention`, `maximum_interval`, `enable_fuzz`, `enable_short_term`, `learning_steps`, `relearning_steps`, `w`. |

Every field but `id` is optional; an unset field falls back to the global
defaults in plugin settings, and nowhere else. `fsrs_params` merges
field-by-field with the defaults. Steps are `"1m"` / `"2h"` / `"1d"` strings.

A malformed field is treated as absent rather than fatal, so one typo costs a
deck one setting instead of all of them.

### Decks without a note

A deck id that appears on cards but has no deck note still works: it resolves
to the global defaults and reports `registered: false`. Nothing silently drops
out of the review queue. The settings tab lists such decks with a button to
create the missing note.

### The blocks

Two code blocks make a deck note a control panel. Both default to the deck of
the note they sit in, so an empty block is the normal case; a `deck:` line
inside the block overrides that — by id or by name — which is how a dashboard
note shows a deck it does not live in.

| Block | Shows |
| --- | --- |
| `flashcard-deck-stats` | Card counts by state, what is due, and today's progress against the limits. |
| `flashcard-deck-settings` | Name, both daily limits, enabled, and target retention — written straight to frontmatter. |

Text fields commit on blur and on Enter rather than per keystroke, since every
commit rewrites the note.

### Global caps

Global caps and the per-deck defaults live in the plugin's own `data.json`,
not in the vault — they are nobody's deck's business, and a config file under
the card folder goes missing the moment that folder is renamed.

`new_per_day_cap` and `reviews_per_day_cap` apply across every deck combined;
`null` disables them. `day_start_hour` (default `4`) is when the review day
rolls over, so a session past midnight still counts as one day.

---

## Programmatic API

The secondary path. Same power, no serialisation.

```ts
import type { FlashcardCoreAPI } from "../flashcard-core/types";

const plugin = (this.app as any).plugins.getPlugin("flashcard-core");
if (!plugin) { new Notice("Flashcard Core is not installed"); return; }
const core = plugin.api as FlashcardCoreAPI;
if (core.schemaVersion !== "1.0") { /* handle a newer core */ }
```

`types.ts` is dependency-free — it imports neither `obsidian` nor `ts-fsrs` — so
you can add this plugin's folder to your `tsconfig` paths or just copy the file
into your own source tree.

### Ingestion

| Method | Returns |
| --- | --- |
| `upsertCards(spec: IngestSpec)` | `Promise<IngestResult>` |
| `deleteCards(ids: string[])` | `Promise<number>` |
| `deleteByDeck(deck, sourcePlugin)` | `Promise<number>` |

### Reading

| Method | Returns |
| --- | --- |
| `getCard(id)` | `CardRecord \| null` |
| `getCards(deck?)` | `CardRecord[]` — one deck, or everything |
| `getDueCards(deck?, limit?)` | `CardRecord[]` — non-new, due now, most overdue first. Respects `max_reviews_per_day` unless `limit` is given. |
| `buildQueue(options?)` | `Promise<QueueItem[]>` — learning, then reviews, then new |
| `getCardContent(id)` | `Promise<CardContent \| null>` — `{ front, back, extra }` |
| `listDecks()` | `string[]` — every deck with cards or a deck note |
| `listDeckNotes()` | `DeckNote[]` — registered decks only |
| `resolveDeckRef(ref)` | `string` — deck id, from an id or a display name |
| `getDeckStats(deck)` | `DeckDailyStats` — today's counters, per-state counts, due count |

`buildQueue` options: `{ deck?, limit?, no_new?, ignore_limits? }`.

### Reviewing

| Method | Returns |
| --- | --- |
| `reviewCard(id, rating)` | `Promise<ReviewResult>` — `rating` is `1` Again, `2` Hard, `3` Good, `4` Easy |
| `previewRatings(id)` | `RatingPreview \| null` — next due date and label per grade, nothing committed |
| `forgetCard(id)` | `Promise<CardRecord>` — reset to `new` |
| `onReview(handler)` | `Unregister` — fires after every grade |

`reviewCard` runs FSRS, writes the new state to the note's frontmatter via
`processFrontMatter` (the body is untouched), and updates the daily counters.
`ReviewResult.introduced` tells you whether that grade consumed a new-card slot.

### Configuration

| Method | Returns |
| --- | --- |
| `getDeckConfig(deck)` | `ResolvedDeckConfig` — defaults filled in, plus `registered` |
| `getRawDeckConfig(deck)` | `DeckNote \| null` — the note as written |
| `setDeckConfig(deck, partial)` | `Promise<ResolvedDeckConfig>` — merges into frontmatter |
| `createDeckNote(folder, id, config?)` | `Promise<DeckNote>` — registers a folder as a deck |
| `getGlobalSettings()` / `setGlobalSettings(partial)` | `GlobalDeckSettings` |

Passing `undefined` for a field in `setDeckConfig` clears it back to the
global default. `setDeckConfig` throws for a deck with no note; call
`createDeckNote(folder, id)` first.

### Ordering and UI

| Method | Returns |
| --- | --- |
| `registerNewCardOrderProvider(provider)` | `Unregister` |
| `startReview(deck?)` | `Promise<void>` — opens the review modal |

---

## Browsing with Bases

There is no browse UI here, by design. Run **Flashcard Core: Create a Bases view
for the collection** to drop a `Flashcards.base` into the root folder with four
views: *Due now*, *By deck*, *New backlog*, and *Leeches*.

### Never filter on `fsrs_state`

A card that has not been reviewed carries **no `fsrs_*` keys at all** — the
plugin writes them on the first grade. In Bases an absent property is neither
equal nor unequal to a value, so both of these are traps:

| Filter | What you expect | What you get |
| --- | --- | --- |
| `fsrs_state == "new"` | the new backlog | **nothing** |
| `fsrs_state != "new"` | cards in rotation | **every card** |

Use `fsrs_reps > 0` for "has been reviewed" and `not: [fsrs_reps > 0]` for its
complement: a missing number simply fails the comparison, which is the
behaviour you want. For display, normalise with a formula —
`state: 'if(fsrs_state, fsrs_state, "new")'` — so a never-reviewed card reads
as `new` instead of blank.

The essentials:

```yaml
filters:
  and:
    - 'fc == "card"'
formulas:
  state: 'if(fsrs_state, fsrs_state, "new")'
  reps: 'if(fsrs_reps, fsrs_reps, 0)'
views:
  - type: table
    name: Due now
    filters:
      and:
        - 'fsrs_reps > 0'
        - 'date(fsrs_due) <= now()'
    order:
      - file.name
      - deck
      - fsrs_due
      - formula.state
    sort:
      - property: fsrs_due
        direction: ASC
  - type: table
    name: By deck
    groupBy:
      property: deck
      direction: ASC
```

Bare property names refer to note frontmatter; `file.*` is file metadata and
`formula.*` is a formula you define in the `formulas` block. Because every
scheduling field is a plain frontmatter property, sorting by stability, grouping
by source plugin, or filtering for leeches (`fsrs_lapses >= 4`) is all a matter
of editing the Base — no plugin change required.

---

## Reviewing in a note

A ```` ```flashcard ```` block puts one deck's queue in the page:

````markdown
```flashcard
deck: MSA vocabulary
```
````

The value is an id or a display name, so blocks stay readable even though ids
are opaque.

A block with no `deck:` renders a **Choose deck…** button; picking a deck writes
`deck: <id>` into the block, so the choice lives in the note and survives
everything. A bare deck reference on its own line is read the same way — a deck
name can never contain a colon, which is the whole difference between the two
shapes.

The block then has exactly two states:

- **Cards waiting** — the reviewer itself, inline: front, **Show answer**, the
  four grades with their intervals, replay and skip. Same code as the modal,
  same API, so a card graded here is graded everywhere.
- **Nothing waiting** — *No cards currently to review*, with the deck's numbers
  underneath (due now, new left today, reviews left today), a **Check again**
  button and a **Change deck** button. The counts are there because "nothing is
  due" and "today's cap is spent" look identical from the outside.

A block can also slow its audio down — for a long sentence you can nearly
follow and just need said slower:

````markdown
```flashcard
deck: MSA vocabulary
default speed: 0.75
```
````

Every audio player on the card starts at that speed: autoplay, **Replay audio**
and the player's own play button alike, with pitch kept so slowed speech still
sounds like the speaker. `speed:` is the short spelling, and `0.75x` and `75%`
both work. It is clamped to 0.25–4; a value that is not a number is ignored and
the audio plays as recorded. The speed belongs to the block, not the deck, so
the same deck can be reviewed at full speed in the modal or another note.

Like the deck-scoped commands, `deck:` covers the deck and everything under it:
`language` reviews `language/arabic/al-ayyam-ch1` too.

The review keys work inside a block, but only while the block has focus —
clicking anywhere in it is enough. That is deliberate: **1**–**4** must never
grade a card because a note happened to be open. A block whose queue empties
mid-session returns to the message rather than stranding a summary on the page,
and one that says "nothing to review" re-checks itself when the index changes,
so a cold start or a fresh batch of generated cards does not leave a stale
message on screen.

---

## Resetting a card

Every card note carries a panel above its body — the deck, the card's state,
its reps and lapses, and a **Reset card to new** button. It is injected by a
post-processor, not written into the note, because card bodies are
generator-owned and rewritten on every regeneration.

The same action is on the note's context menu, which is what to use in editing
view or on a row in a Base, where the panel does not render.

Reset goes through FSRS's own `forget()`, so it clears `fsrs_stability`,
`fsrs_difficulty`, `fsrs_reps`, `fsrs_lapses`, `fsrs_scheduled_days`, and
`fsrs_learning_steps` along with `fsrs_state`. **Editing `fsrs_state` by hand
is not equivalent** — the card does return to the new queue, but `reps` and
`lapses` are passed through to FSRS untouched, so its history stays wrong
forever. `fsrs_last_review` is deliberately left at the reset time; a new
card's first schedule ignores it, so it reads as "last touched".

To reset a whole deck at once, use **Start a deck over…** instead of clicking
through it card by card.

## Commands

| Command | What it does |
| --- | --- |
| Review all decks | Opens the reviewer over every enabled deck. |
| Review a deck… | Deck picker showing due and remaining-new counts. |
| Review the deck of the active card | Contextual, when a card note is open. |
| Rebuild card index | Full rescan. |
| Show deck statistics | Counts and remaining daily budget. |
| Why is this card not being introduced? | Names the gating prerequisites, or the limit that is in the way. Start here when a card will not appear. |
| Reset the active card to new | Discards its scheduling history. |
| Start a deck over… | Every card in one deck back to `new`, and that deck's counters for today cleared. Asks first; cannot be undone. |
| List registered new-card order providers | Which generator is ordering which deck. |
| Create a Bases view for the collection | Writes the starter `.base`. |

### In the reviewer

| Default key | Action | What it does |
| --- | --- | --- |
| **Space** | Next card | Reveals the answer; once it is showing, moves on **without grading** |
| **Enter** | Reveal answer | Shows the back. Inert once the back is showing |
| **1** | Grade: Again | Did not recall it |
| **2** | Grade: Hard | Recalled, with difficulty |
| **3** | Grade: Good | Recalled correctly |
| **4** | Grade: Easy | Recalled instantly |
| **r** | Replay audio | Restarts the audio on the side showing |
| **u** | Skip card | Drops the card from this session without recording anything |

Grading lives exclusively on **1**–**4**. Space only ever moves you forward — it
never writes a grade — so the key you lean on to get through a session cannot
quietly record a *Good* you did not choose.

**r** prefers the side you are looking at, falling back to anywhere on the card,
so a listening prompt with audio only on the front stays replayable after the
flip. A **Replay audio** button appears whenever the card actually embeds audio.

### Rebinding

**Settings → Flashcard Core → Review hotkeys.** Click an action's key, press the
key you want, and it saves. **Backspace** clears a binding (the action then only
has its on-screen button); **Escape** cancels the capture. Each row has a reset
arrow, and there is a *Reset all* at the bottom.

Modifiers work — `Ctrl+R`, `Shift+3`, `Alt+Space`. Two actions sharing a key are
flagged inline rather than blocked, since some overlaps are harmless.

These cannot live in Obsidian's own Hotkeys pane: that binds commands registered
with `addCommand`, which are global, whereas these are scoped to the review
modal and mean different things before and after the answer is revealed. They
are stored in the plugin's `data.json` under `hotkeys`, in readable form
(`"Space"`, `"Ctrl+r"`), so you can also edit them by hand.

On-screen button labels show whatever key is currently bound, so they never
drift from your configuration.

---

## Development

```bash
npm install
npm run dev       # watch build
npm run build     # typecheck + production bundle
npm run verify    # logic tests, no Obsidian required
```

`npm run verify` bundles the pure modules with a stubbed `obsidian` and a fake
in-memory vault, then exercises scheduling, deck notes, daily budgets,
prerequisite gating, provider precedence, and — most importantly — that
regeneration preserves FSRS state.

### Layout

| File | Role |
| --- | --- |
| `types.ts` | The public contract. No runtime dependencies; copy or import freely. |
| `main.ts` | Plugin lifecycle, commands, the Bases template. |
| `src/scheduler.ts` | The only file that imports `ts-fsrs`. |
| `src/note.ts` | Card-note format: frontmatter, sections, media embeds, paths. |
| `src/store.ts` | The card index and all vault I/O. |
| `src/ingest.ts` | JSON validation and upsert orchestration. |
| `src/deck-notes.ts` | Deck-note discovery and config resolution. |
| `src/deck-block.ts` | The two deck-note code blocks. |
| `src/daily.ts` | Introduction and review accounting. |
| `src/queue.ts` | Eligibility, ordering, and budgets — which cards a session may contain. |
| `src/session.ts` | Session pacing — the order you meet them in. The only mutable view of a queue. |
| `src/api.ts` | `FlashcardCoreAPI` implementation. |
| `src/hotkeys.ts` | Review actions, default bindings, and binding parsing. |
| `src/review-view.ts` | The review UI, free of any surface of its own. |
| `src/review-modal.ts` | Modal plumbing around `ReviewView`: window, key scope, close. |
| `src/flashcard-block.ts` | The ```` ```flashcard ```` block: deck persistence and the two states. |

Swapping the scheduler means rewriting `src/scheduler.ts` and nothing else:
everything above it speaks `FsrsState`, which is plain JSON with ISO timestamps
and lowercase state names.

See `example-generator.md` for a minimal generator plugin.
