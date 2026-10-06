// Frontmatter audit for one deck: does every card carry what the plugin and a
// Bases view need, and is the FSRS block internally consistent?
// Usage: node test/audit-cards.mjs <vault> <deck id>
import fs from "node:fs";
import path from "node:path";

const vault = process.argv[2];
const wanted = process.argv[3];
const skip = (name) => name.startsWith(".") || name === "node_modules";

const GENERATOR_KEYS = ["fc", "id", "deck", "source_plugin", "template", "fc_new_order"];
const FSRS_KEYS = [
	"fsrs_due", "fsrs_stability", "fsrs_difficulty", "fsrs_reps", "fsrs_lapses",
	"fsrs_state", "fsrs_last_review", "fsrs_learning_steps", "fsrs_scheduled_days",
];
const STATES = new Set(["new", "learning", "review", "relearning"]);
const TEMPLATES = new Set(["basic", "cloze", "audio", "visual"]);

function raw(text) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return null;
	const out = {};
	const lines = m[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
		if (!kv) continue;
		const [, key, rest] = kv;
		if (rest.trim() === "") {
			const items = [];
			while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
				items.push(lines[++i].replace(/^\s*-\s+/, "").trim());
			}
			out[key] = items;
		} else if (rest.trim() === "[]") out[key] = [];
		else out[key] = rest.trim().replace(/^["']|["']$/g, "");
	}
	return out;
}

const cards = [];
(function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (skip(e.name)) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith(".md")) {
			const fm = raw(fs.readFileSync(p, "utf8"));
			if (fm?.fc === "card" && fm.deck === wanted) {
				cards.push({ path: path.relative(vault, p).split(path.sep).join("/"), fm });
			}
		}
	}
})(vault);

console.log(`${cards.length} cards in ${wanted}\n`);

const problems = [];
const seenIds = new Map();
const seenOrder = new Map();
let withFsrs = 0;
let withoutFsrs = 0;

for (const { path: p, fm } of cards) {
	const name = p.split("/").pop();
	const flag = (msg) => problems.push(`${name}: ${msg}`);

	for (const key of GENERATOR_KEYS) {
		if (fm[key] === undefined || fm[key] === "") flag(`missing ${key}`);
	}
	if (fm.id && !fm.id.includes(":")) flag(`id "${fm.id}" is not namespaced`);
	if (fm.id) {
		if (seenIds.has(fm.id)) flag(`duplicate id, also in ${seenIds.get(fm.id)}`);
		else seenIds.set(fm.id, name);
	}
	if (fm.template && !TEMPLATES.has(fm.template)) flag(`unknown template "${fm.template}"`);
	if (fm.fc_new_order !== undefined && !/^-?\d+(\.\d+)?$/.test(String(fm.fc_new_order))) {
		flag(`fc_new_order "${fm.fc_new_order}" is not a number`);
	} else if (fm.fc_new_order !== undefined) {
		const key = String(fm.fc_new_order);
		if (seenOrder.has(key)) seenOrder.set(key, seenOrder.get(key) + 1);
		else seenOrder.set(key, 1);
	}
	if (fm.fc_prerequisites !== undefined && !Array.isArray(fm.fc_prerequisites)) {
		flag(`fc_prerequisites is not a list`);
	}

	// FSRS: all nine keys or none. A partial block is what makes a Bases
	// filter behave unpredictably, so it is worth naming precisely.
	const present = FSRS_KEYS.filter((k) => fm[k] !== undefined);
	if (present.length === 0) {
		withoutFsrs++;
	} else if (present.length === FSRS_KEYS.length) {
		withFsrs++;
		if (!STATES.has(fm.fsrs_state)) flag(`invalid fsrs_state "${fm.fsrs_state}"`);
		const reps = Number(fm.fsrs_reps);
		if (fm.fsrs_state === "new" && reps > 0) {
			flag(`state is new but fsrs_reps is ${reps} — hand-edited, history not cleared`);
		}
		if (fm.fsrs_state !== "new" && reps === 0) {
			flag(`state is ${fm.fsrs_state} but fsrs_reps is 0`);
		}
	} else {
		flag(`partial FSRS block: has ${present.join(", ")}; missing ${FSRS_KEYS.filter((k) => fm[k] === undefined).join(", ")}`);
	}
}

console.log(`FSRS block: ${withFsrs} complete, ${withoutFsrs} absent (never reviewed)`);
const dupOrders = [...seenOrder].filter(([, n]) => n > 1);
if (dupOrders.length > 0) {
	console.log(`duplicate fc_new_order values: ${dupOrders.map(([v, n]) => `${v}×${n}`).join(", ")}`);
}

console.log(`\nstates: ${JSON.stringify(
	cards.reduce((acc, { fm }) => {
		const s = fm.fsrs_state ?? "(absent)";
		acc[s] = (acc[s] ?? 0) + 1;
		return acc;
	}, {}),
)}`);

if (problems.length === 0) console.log("\nOK — no frontmatter problems");
else {
	console.log(`\n${problems.length} problem(s):`);
	for (const p of problems) console.log(`  ${p}`);
	process.exitCode = 1;
}
