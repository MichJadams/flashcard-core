// A fake vault good enough to exercise CardStore, ingest, and QueueBuilder.
import { TFile, TFolder } from "./bundle.mjs";

function splitFrontmatter(content) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	if (!m) return null;
	try { return JSON.parse(m[1]); } catch { return null; }
}

export function makeApp() {
	const files = new Map(); // path -> content
	const folders = new Set();
	const handlers = { changed: [], deleted: [], delete: [], rename: [] };

	const fileFor = (p) => (files.has(p) ? new TFile(p) : undefined);

	const app = {
		vault: {
			getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map((p) => new TFile(p)),
			getAbstractFileByPath: (p) => (files.has(p) ? new TFile(p) : folders.has(p) ? new TFolder(p) : null),
			read: async (f) => files.get(f.path),
			cachedRead: async (f) => files.get(f.path),
			modify: async (f, content) => {
				files.set(f.path, content);
				emit("changed", new TFile(f.path));
			},
			create: async (p, content) => {
				files.set(p, content);
				emit("changed", new TFile(p));
				return new TFile(p);
			},
			createFolder: async (p) => { folders.add(p); },
			adapter: {
				exists: async (p) => files.has(p) || folders.has(p),
				read: async (p) => files.get(p),
				write: async (p, v) => { files.set(p, v); },
			},
			on: (name, fn) => { handlers[name]?.push(fn); return { name, fn }; },
			offref: () => {},
		},
		metadataCache: {
			getFileCache: (f) => {
				const content = files.get(f.path);
				if (content === undefined) return null;
				const fm = splitFrontmatter(content);
				return fm ? { frontmatter: fm } : {};
			},
			on: (name, fn) => { handlers[name]?.push(fn); return { name, fn }; },
			offref: () => {},
		},
		fileManager: {
			processFrontMatter: async (f, fn) => {
				const content = files.get(f.path) ?? "";
				const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
				const fm = m ? (JSON.parse(m[1]) ?? {}) : {};
				const body = m ? content.slice(m[0].length) : content;
				fn(fm);
				files.set(f.path, `---\n${JSON.stringify(fm)}\n---\n${body}`);
				emit("changed", new TFile(f.path));
			},
			renameFile: async (f, target) => {
				const content = files.get(f.path);
				files.delete(f.path);
				files.set(target, content);
				emit("rename", new TFile(target), f.path);
			},
			trashFile: async (f) => {
				files.delete(f.path);
				emit("delete", new TFile(f.path));
			},
		},
		workspace: { onLayoutReady: (fn) => fn(), getActiveFile: () => null },
	};

	function emit(name, ...args) {
		for (const fn of handlers[name] ?? []) {
			if (name === "changed") fn(args[0], files.get(args[0].path), app.metadataCache.getFileCache(args[0]));
			else fn(...args);
		}
	}

	return { app, files, folders };
}
