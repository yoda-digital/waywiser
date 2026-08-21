import esbuild from "esbuild";
import process from "process";
import { copyFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const prod = process.argv[2] === "production";
const __dirname = dirname(fileURLToPath(import.meta.url));

// sql.js's node build (dist/sql-wasm.js) loads its .wasm file relative to
// __dirname at runtime rather than importing it, so esbuild's bundler can't
// see that dependency statically. Copy the wasm binary next to main.js on
// every build so the plugin can actually load it once installed in a vault.
const copyWasmPlugin = {
  name: "copy-sql-wasm",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      copyFileSync(
        join(__dirname, "node_modules/sql.js/dist/sql-wasm.wasm"),
        join(__dirname, "sql-wasm.wasm")
      );
    });
  },
};

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  outfile: "main.js",
  platform: "node",
  plugins: [copyWasmPlugin],
  define: {
    "process.env.NODE_ENV": JSON.stringify(prod ? "production" : "development"),
  },
}).catch(() => process.exit(1));
