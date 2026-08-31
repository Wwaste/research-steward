import { build } from "esbuild";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  write: false,
  banner: { js: shared.banner.js }
});
const schemaSource = schemaBundle.outputFiles?.[0]?.text;
if (!schemaSource) throw new Error("Schema generator bundle was empty.");
// The generator now transitively bundles CommonJS dependencies whose dynamic
// require() needs createRequire(import.meta.url); that only works from a
// file: URL, so import a temporary on-disk bundle instead of a data: URL.
const schemaTempDirectory = await mkdtemp(join(tmpdir(), "research-steward-schema-gen-"));
try {
  const schemaEntry = join(schemaTempDirectory, "generate-schemas.mjs");
  await writeFile(schemaEntry, schemaSource, "utf8");
  const schemaModule = await import(pathToFileURL(schemaEntry).href);
  await schemaModule.generateSchemas();
} finally {
  await rm(schemaTempDirectory, { recursive: true, force: true });
}

await Promise.all([
  chmod("dist/server.mjs", 0o755),
  chmod("dist/cli.mjs", 0o755)
]);
