// Build one deck's real review queue, out of app, to see what the plugin sees.
// Usage: node test/check-deck.mjs <vault> <deck ref>
import fs from "node:fs";
import path from "node:path";
import * as M from "./bundle.mjs";
import { TFile } from "./bundle.mjs";

const vault = process.argv[2];
const ref = process.argv[3];
const skip = (name) => name.startsWith(".") || name === "node_modules";

/**
 * Frontmatter parser covering what these notes actually use: scalars, `[]`,
 * inline `[a, b]`, and block lists. Getting `fc_prerequisites: []` wrong would
 * make every card look gated, so this has to be right or the report lies.
 */
function parseFm(text) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return null;
	const fm = {};
	const lines = m[1].split(/\r?\n/);
	const scalar = (raw) => {
		let v = raw.trim();
		if (v === "") return "";
		const unq = v.replace(/^["']|["']$/g, "");
		if (unq === "true") return true;
		if (unq === "false") return false;
		if (unq === "null" || unq === "~") return null;
		if (/^-?\d+(\.\d+)?$/.test(unq)) return Number(unq);
		return unq;
	};
	for (let i = 0; i < lines.length; i++) {
		const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
		if (!kv) continue;
		const [, key, rest] = kv;
		if (rest.trim() === "") {
			// A block list follows, or the key is genuinely empty.
			const items = [];
			while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
				items.push(scalar(lines[++i].replace(/^\s*-\s+/, "")));
			}
			fm[key] = items.length > 0 ? items : "";
		} else if (/^\[\s*\]$/.test(rest.trim())) {
			fm[key] = [];
		} else if (/^\[.*\]$/.test(rest.trim())) {
			fm[key] = rest
				.trim()
				.slice(1, -1)
				.split(",")
				.map(scalar)
				.filter((v) => v !== "");
		} else {
			fm[key] = scalar(rest);
		}
	}
	return fm;
}

const notes = new Map();
(function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (skip(e.name)) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith(".md")) {
			const rel = path.relative(vault, p).split(path.sep).join("/");
			notes.set(rel, parseFm(fs.readFileSync(p, "utf8")));
		}
	}
})(vault);

const app = {
	vault: {
		getMarkdownFiles: () => [...notes.keys()].map((p) => new TFile(p)),
		getAbstractFileByPath: (p) => (notes.has(p) ? new TFile(p) : null),
		on: () => ({}),
		offref: () => {},
	},
	metadataCache: {
		getFileCache: (f) => {
			const fm = notes.get(f.path);
			return fm ? { frontmatter: fm } : {};
		},
		on: () => ({}),
		offref: () => {},
	},
};

const globals = structuredClone(M.DEFAULT_GLOBAL);
const decks = new M.DeckNoteStore(app, () => globals, async () => {});
decks.start();

const store = new M.CardStore(app, "flashcards", (d) => decks.resolve(d).folder);
store.start();

const deck = decks.byRef(ref);
const config = decks.resolve(deck);
const ledger = new M.DailyLedger(undefined, globals.day_start_hour, async () => {});
const now = new Date();

console.log(`ref "${ref}" -> deck id "${deck}"`);
console.log(`name: ${config.name}   registered: ${config.registered}`);
console.log(`note: ${config.path ?? "(none)"}`);
console.log(`limits: ${config.new_per_day} new/day, ${config.max_reviews_per_day} reviews/day`);
console.log(`enabled: ${config.enabled}\n`);

const cards = store.inDeck(deck);
console.log(`cards in deck: ${cards.length}`);
const byState = {};
for (const c of cards) byState[c.fsrs.state] = (byState[c.fsrs.state] ?? 0) + 1;
console.log(`by state: ${JSON.stringify(byState)}`);

// Eligibility: a bad prerequisite is the classic reason a card never appears.
const index = new Map(store.all().map((c) => [c.id, c]));
for (const c of cards) {
	if (c.fsrs.state !== "new") continue;
	const reasons = M.blockedBy(c, index);
	if (reasons.length > 0) console.log(`  BLOCKED ${c.id}: ${reasons.join("; ")}`);
}

// Media: an embed pointing at a file that is not there plays silence.
let missing = 0;
for (const c of cards) {
	const body = fs.readFileSync(path.join(vault, c.path), "utf8");
	for (const [, target] of body.matchAll(/!\[\[([^\]|#]+)/g)) {
		const name = target.trim();
		const direct = path.join(vault, name);
		const beside = path.join(vault, path.dirname(c.path), name);
		if (!fs.existsSync(direct) && !fs.existsSync(beside)) {
			console.log(`  MISSING MEDIA ${c.path} -> ${name}`);
			missing++;
		}
	}
}
console.log(`missing media: ${missing}`);

const builder = new M.QueueBuilder({ store, decks, ledger, providers: () => [] });
const queue = await builder.build({ deck }, now);
console.log(`\nqueue right now: ${queue.length} items`);
for (const item of queue) {
	console.log(`  ${item.reason.padEnd(9)} ${item.card.id}  (due ${item.card.fsrs.due})`);
}

const stats = {
	due_now: cards.filter(
		(c) => c.fsrs.state !== "new" && new Date(c.fsrs.due).getTime() <= now.getTime(),
	).length,
};
console.log(`\ndue now (ignoring limits): ${stats.due_now}`);
