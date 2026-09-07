// End-to-end check against the real vault: feed the actual deck notes and
// card frontmatter through the shipped DeckNoteStore and Budget.
import fs from "node:fs";
import path from "node:path";
import * as M from "./bundle.mjs";
import { TFile } from "./bundle.mjs";

const vault = process.argv[2];
// Anything dot-prefixed, exactly as Obsidian itself ignores it — otherwise a
// migration backup sitting in the vault shows up as a second set of decks.
const skip = (name) => name.startsWith(".") || name === "node_modules";

/** Enough YAML for the flat scalar frontmatter these notes use. */
function parseFm(text) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return null;
	const fm = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
		if (!kv) continue;
		let v = kv[2].trim().replace(/^["']|["']$/g, "");
		if (v === "") continue;
		if (v === "true") v = true;
		else if (v === "false") v = false;
		else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
		fm[kv[1]] = v;
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

// Card decks, straight from frontmatter, the same way CardStore reads them.
const cardDecks = new Map();
for (const [p, fm] of notes) {
	if (fm?.fc !== "card" || typeof fm.deck !== "string") continue;
	cardDecks.set(fm.deck, (cardDecks.get(fm.deck) ?? 0) + 1);
}

console.log(`discovered ${decks.all().length} deck notes\n`);
console.log("deck id".padEnd(34) + "cards  new/day  name");
const ledger = new M.DailyLedger(undefined, 4, async () => {});
const budget = M.Budget.forNew(decks, ledger, new Date());

let problems = 0;
for (const id of [...cardDecks.keys()].sort()) {
	const r = decks.resolve(id);
	const remaining = budget.remaining(id, "new");
	if (!r.registered) problems++;
	if (remaining !== r.new_per_day) problems++;
	console.log(
		id.padEnd(34) +
			String(cardDecks.get(id)).padStart(5) +
			String(r.new_per_day).padStart(9) +
			"  " +
			(r.registered ? r.name : "*** UNREGISTERED ***") +
			(remaining === r.new_per_day ? "" : `  [budget says ${remaining}]`),
	);
}

// Decks with a note but no cards would be a migration typo in an id.
for (const note of decks.all()) {
	if (!cardDecks.has(note.id)) {
		problems++;
		console.log(`*** deck note "${note.id}" matches no cards (${note.path})`);
	}
}

console.log(`\n${problems === 0 ? "OK — every deck registered and budgeted" : problems + " PROBLEM(S)"}`);
process.exitCode = problems === 0 ? 0 : 1;
