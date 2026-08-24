import esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["test/entry.ts"],
  bundle: true, format: "esm", platform: "node", target: "node18",
  outfile: "test/bundle.mjs",
  alias: { obsidian: "./test/stub-obsidian.mjs" },
  logLevel: "warning",
});
