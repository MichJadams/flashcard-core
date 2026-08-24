// Minimal Obsidian stand-in for out-of-app verification.
// YAML is swapped for JSON, which round-trips through the same code paths.

export function parseYaml(s) {
	try { return JSON.parse(s); } catch { return {}; }
}
export function stringifyYaml(o) {
	return JSON.stringify(o) + "\n";
}
export function normalizePath(p) {
	return String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export class TFile {
	constructor(path) { this.path = path; this.extension = path.split(".").pop(); }
}
export class TFolder {
	constructor(path) { this.path = path; }
}
export class Component { load() {} unload() {} addChild(c) { return c; } register() {} }
export class MarkdownRenderChild extends Component { constructor(el) { super(); this.containerEl = el; } }
export class Modal {}
export class Notice { constructor(m) { this.message = m; } }
export class FuzzySuggestModal {}
export class PluginSettingTab {}
export class Setting {}
export class Plugin {}
export const MarkdownRenderer = { render: async () => {} };
