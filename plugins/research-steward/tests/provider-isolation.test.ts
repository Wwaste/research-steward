import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoundtableNode } from "../src/protocol.js";
import { runProvider } from "../src/providers.js";
import { expectErrorCode, temporaryDirectory } from "./helpers.js";

const managedEnvironment = [
  "RESEARCH_STEWARD_QODER_PATH",
  "RESEARCH_STEWARD_KIMI_PATH",
  "RESEARCH_STEWARD_GROK_PATH",
  "RESEARCH_STEWARD_MAX_PROVIDER_CONCURRENCY",
  "XAI_API_KEY"
] as const;
const originalEnvironment = Object.fromEntries(
  managedEnvironment.map((name) => [name, process.env[name]])
);

afterEach(() => {
  for (const name of managedEnvironment) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

async function executable(root: string, name: string, body: string): Promise<string> {
  const filePath = path.join(root, name);
  await writeFile(filePath, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  await chmod(filePath, 0o700);
  return filePath;
}

function node(adapter: "qoder" | "grok" | "kimi", timeoutMs = 5_000): RoundtableNode {
  return {
    id: `${adapter}-isolation`,
    actor_id: `${adapter}-tester`,
    role: "provider isolation tester",
    adapter,
    model:
      adapter === "grok"
        ? "grok-4.6"
        : adapter === "kimi"
          ? "kimi-code/k3"
          : "Qwen3.8-Max",
    brief: "Return a bounded structured test result.",
    depends_on: [],
    visibility: "shared",
    can_adjudicate: false,
    timeout_ms: timeoutMs
  };
}

const validOutput = JSON.stringify({
  status: "complete",
  summary: "provider boundary held",
  uncertainties: [],
  evidence: [],
  findings: [],
  decisions: []
});

describe("provider process isolation", () => {
  it("runs Qoder in a sealed cwd with tools, sessions, plugins, and MCP disabled", async () => {
    const root = await temporaryDirectory("research-steward-provider-isolation-");
    const shim = await executable(
      root,
      "qoder-shim.mjs",
      `import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const ownDirectory = dirname(fileURLToPath(import.meta.url));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
const checks = [
  process.cwd() !== ownDirectory,
  args[args.indexOf("--tools") + 1] === "",
  args.includes("--no-session-persistence"),
  args.includes("--strict-mcp-config"),
  args[args.indexOf("--mcp-config") + 1] === '{"mcpServers":{}}',
  args[args.indexOf("--input-format") + 1] === "text",
  args.includes("--plugin-dir"),
  !args.includes("sealed prompt"),
  input === "sealed prompt"
];
if (!checks.every(Boolean)) process.exit(23);
process.stdout.write(${JSON.stringify(validOutput)});
});`
    );
    process.env["RESEARCH_STEWARD_QODER_PATH"] = shim;

    const result = await runProvider(node("qoder"), "sealed prompt", root, 10_000);
    expect(result.output.summary).toBe("provider boundary held");
    expect(result.executable_name).toBe("qoder-shim.mjs");
  });

  it("removes separately metered XAI_API_KEY from a Grok subscription process", async () => {
    const root = await temporaryDirectory("research-steward-grok-cost-boundary-");
    const shim = await executable(
      root,
      "grok-shim.mjs",
      `import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const promptPath = args[args.indexOf("--prompt-file") + 1];
if (process.env.XAI_API_KEY || !promptPath || readFileSync(promptPath, "utf8") !== "subscription prompt") process.exit(29);
process.stdout.write(${JSON.stringify(validOutput)});`
    );
    process.env["RESEARCH_STEWARD_GROK_PATH"] = shim;
    process.env["XAI_API_KEY"] = "must-not-cross-the-provider-boundary";

    const result = await runProvider(node("grok"), "subscription prompt", root, 10_000);
    expect(result.output.status).toBe("complete");
  });

  it("enforces a process-wide provider concurrency permit", async () => {
    const root = await temporaryDirectory("research-steward-provider-concurrency-");
    const logPath = path.join(root, "provider-order.log");
    const shim = await executable(
      root,
      "serial-shim.mjs",
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(logPath)}, "start\\n");
setTimeout(() => {
  appendFileSync(${JSON.stringify(logPath)}, "end\\n");
  process.stdout.write(${JSON.stringify(validOutput)});
}, 200);`
    );
    process.env["RESEARCH_STEWARD_QODER_PATH"] = shim;
    process.env["RESEARCH_STEWARD_MAX_PROVIDER_CONCURRENCY"] = "1";

    await Promise.all([
      runProvider({ ...node("qoder"), id: "serial-a" }, "one", root, 10_000),
      runProvider({ ...node("qoder"), id: "serial-b" }, "two", root, 10_000)
    ]);
    expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual([
      "start",
      "end",
      "start",
      "end"
    ]);
  });

  it("kills the provider process group when its deadline expires", async () => {
    const root = await temporaryDirectory("research-steward-provider-tree-");
    const sentinel = path.join(root, "orphan-child-wrote.txt");
    const childProgram = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
      sentinel
    )}, "orphan"), 1400)`;
    const shim = await executable(
      root,
      "tree-shim.mjs",
      `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { stdio: "ignore" });
child.unref();
setInterval(() => {}, 1000);`
    );
    process.env["RESEARCH_STEWARD_QODER_PATH"] = shim;

    await expectErrorCode(
      runProvider(node("qoder", 1_000), "timeout prompt", root, 10_000),
      "PROVIDER_TIMEOUT"
    );
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an argv-bound prompt before spawning Kimi", async () => {
    const root = await temporaryDirectory("research-steward-provider-prompt-");
    const shim = await executable(root, "unused-shim.mjs", `process.exit(99);`);
    process.env["RESEARCH_STEWARD_KIMI_PATH"] = shim;

    await expectErrorCode(
      runProvider(node("kimi"), "x".repeat(100_000), root, 10_000),
      "PROVIDER_PROMPT_ARG_LIMIT"
    );
  });
});
