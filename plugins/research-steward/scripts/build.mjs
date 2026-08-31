import { build } from "esbuild";
import { chmod } from "node:fs/promises";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "linked",
  logLevel: "info",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __researchStewardCreateRequire } from 'node:module';\nconst require = __researchStewardCreateRequire(import.meta.url);"
  }
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/server-entry.ts"],
    outfile: "dist/server.mjs"
  }),
  build({
    ...shared,
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.mjs"
  })
]);

const schemaBundle = await build({
  entryPoints: ["src/generate-schemas.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  logLevel: "silent",
  write: false
});
const schemaSource = schemaBundle.outputFiles?.[0]?.text;
if (!schemaSource) throw new Error("Schema generator bundle was empty.");
const schemaModule = await import(
  `data:text/javascript;base64,${Buffer.from(schemaSource).toString("base64")}`
);
await schemaModule.generateSchemas();

await Promise.all([
  chmod("dist/server.mjs", 0o755),
  chmod("dist/cli.mjs", 0o755)
]);
