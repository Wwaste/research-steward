#!/usr/bin/env node
/**
 * Gate driver: bundles src/workflow via esbuild to a temp file and runs
 * runRoundtable against a project. Black-box for the orchestrator.
 */
import { build } from "esbuild";
import { mkdtemp, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [projectRoot, packetId, runId, shimPath] = process.argv.slice(2);
const tmp = await mkdtemp(path.join(os.tmpdir(), "rs-driver-"));
const out = path.join(tmp, "workflow.bundle.mjs");
const entry = path.join(tmp, "entry.ts");
await writeFile(
  entry,
  'export { runRoundtable } from "./src/workflow.js";\nexport { initializeProject, freezePacket } from "./src/store.js";\n'
);
// rewrite to absolute imports
await writeFile(
  entry,
  `export { runRoundtable } from ${JSON.stringify(path.resolve(import.meta.dirname, "..", "..", "src", "workflow.ts"))};\nexport { initializeProject, freezePacket } from ${JSON.stringify(path.resolve(import.meta.dirname, "..", "..", "src", "store.ts"))};\n`
);
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  external: [],
  banner: {
    js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);'
  }
});
const { realpath } = await import("node:fs/promises");
const projectRootReal = await realpath(projectRoot);
const { runRoundtable, freezePacket, initializeProject } = await import(pathToFileURL(out).href);
// Resume path (G1/G6): if the project is already initialized+frozen, skip
// init/freeze so we do not re-take locks the crashed process left behind.
const eventsDir = path.join(projectRootReal, ".research", "events");
let alreadySeeded = false;
try {
  const names = await readdir(eventsDir);
  const contents = await Promise.all(
    names.filter((n) => n.endsWith(".json")).map(async (n) => {
      try {
        return await readFile(path.join(eventsDir, n), "utf8");
      } catch {
        return "";
      }
    })
  );
  alreadySeeded = contents.some(
    (c) => c.includes("packet_frozen") && c.includes(packetId)
  );
} catch {
  alreadySeeded = false;
}
if (!alreadySeeded) {
  await initializeProject(projectRootReal, "g1-driver");
  await writeFile(path.join(projectRootReal, "n.md"), "x\n");
  await freezePacket(projectRootReal, packetId, ["n.md"]);
}
process.env.RESEARCH_STEWARD_KIMI_PATH = shimPath;
await runRoundtable(projectRootReal, {
  version: 1,
  name: "gate",
  packet_id: packetId,
  mode: "open",
  limits: {
    max_parallel: 1,
    max_wall_time_ms: 30000,
    max_prompt_chars: 20000,
    max_output_chars: 10000,
    retry_limit: 0,
    max_failures: 1
  },
  nodes: [
    {
      id: "n1",
      actor_id: "a1",
      role: "analyst",
      adapter: "kimi",
      model: "kimi-latest",
      brief: "b",
      depends_on: [],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: 15000
    }
  ]
}, runId);
