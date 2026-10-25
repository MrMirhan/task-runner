import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: {
    // The bundled MCP SDK is CommonJS-aware; give it require() in an ES module.
    js: `import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);`,
  },
  logLevel: "info",
});

chmodSync("dist/cli.js", 0o755);

// The dashboard is built separately (npm run build:dashboard); ship whatever was last built.
if (existsSync("dashboard/out/index.html")) {
  rmSync("dist/dashboard", { recursive: true, force: true });
  cpSync("dashboard/out", "dist/dashboard", { recursive: true });
}
