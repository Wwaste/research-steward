import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RootPolicy } from "./paths.js";
import {
  appendEvent,
  freezePacket,
  initializeProject,
  projectSummary,
  recordAcceptance,
  recordProvisionalReview,
  readEvents,
  renderViews,
  resolveBlocks,
  verifyProject
} from "./store.js";
import { runRoundtable } from "./workflow.js";
import { runHttpServer } from "./server.js";
import { packageHandoff } from "./package.js";
import { errorMessage } from "./utils.js";

interface ParsedArguments {
  command: string;
  flags: Map<string, string[]>;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", flags: new Map() };
  }
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${String(token)}`);
    const name = token.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.set(name, [...(flags.get(name) ?? []), "true"]);
    } else {
      flags.set(name, [...(flags.get(name) ?? []), value]);
      index += 1;
    }
  }
  return { command, flags };
}

function one(flags: Map<string, string[]>, name: string, fallback?: string): string {
  const values = flags.get(name);
  const value = values?.at(-1) ?? fallback;
  if (value === undefined) throw new Error(`Missing required --${name}`);
  return value;
}

function all(flags: Map<string, string[]>, name: string): string[] {
  return flags.get(name) ?? [];
}

function printHelp(): void {
  process.stdout.write(`Research Steward CLI

Usage:
  research-steward init --project <dir> --title <title>
  research-steward freeze --project <dir> --packet <id> --file <relative> [--file <relative>] [--supersedes <packet-id>]
  research-steward append --project <dir> --actor <id> --role <role> --summary <text>
  research-steward events --project <dir>
  research-steward status --project <dir>
  research-steward render --project <dir>
  research-steward roundtable --project <dir> --plan <plan.json> [--run-id <id>]
  research-steward verify --project <dir>
  research-steward provisional-review --project <dir> --actor <id> --verification <uuid> --note <text> [--review-by <when>]
  research-steward accept --project <dir> --actor <id> --note <text>
  research-steward resolve-block --project <dir> --actor <id> --event <uuid> [--event <uuid>] --note <text>
  research-steward package --project <dir> --package <id> --file <relative> [--file <relative>]
  research-steward serve-http

The CLI grants exactly the --project directory for that invocation. MCP mode
instead uses client roots or RESEARCH_STEWARD_ROOTS.
`);
}

async function grantedRoot(rawProject: string): Promise<{ root: string; policy: RootPolicy }> {
  const absolute = path.resolve(rawProject);
  const policy = new RootPolicy();
  await policy.setRoots([absolute]);
  return { root: await policy.resolveProject(absolute), policy };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "help" || parsed.flags.has("help")) {
    printHelp();
    return;
  }
  if (parsed.command === "serve-http") {
    await runHttpServer();
    return;
  }

  const rawProject = one(parsed.flags, "project", process.cwd());
  const { root } = await grantedRoot(rawProject);
  let result: unknown;

  switch (parsed.command) {
    case "init":
      result = await initializeProject(root, one(parsed.flags, "title"));
      break;
    case "freeze":
      result = await freezePacket(
        root,
        one(parsed.flags, "packet"),
        all(parsed.flags, "file"),
        all(parsed.flags, "supersedes")
      );
      break;
    case "append":
      result = await appendEvent(root, {
        type: "agent_contribution",
        actor: {
          id: one(parsed.flags, "actor"),
          role: one(parsed.flags, "role"),
          ...(parsed.flags.has("adapter") ? { adapter: one(parsed.flags, "adapter") } : {}),
          ...(parsed.flags.has("model") ? { model: one(parsed.flags, "model") } : {})
        },
        summary: one(parsed.flags, "summary"),
        uncertainties: all(parsed.flags, "uncertainty")
      });
      break;
    case "events":
      result = await readEvents(root);
      break;
    case "status":
      result = await projectSummary(root);
      break;
    case "render":
      await renderViews(root);
      result = { rendered: true };
      break;
    case "roundtable": {
      const plan = JSON.parse(await readFile(path.resolve(one(parsed.flags, "plan")), "utf8")) as unknown;
      const workflowResult = await runRoundtable(
        root,
        plan,
        parsed.flags.has("run-id") ? one(parsed.flags, "run-id") : undefined
      );
      result = workflowResult;
      if (workflowResult.outcome !== "complete") process.exitCode = 2;
      break;
    }
    case "verify":
      result = await verifyProject(root);
      break;
    case "provisional-review":
      result = await recordProvisionalReview(
        root,
        one(parsed.flags, "actor"),
        one(parsed.flags, "verification"),
        one(parsed.flags, "note", "Provisionally reviewed; named human confirmation remains required."),
        one(parsed.flags, "review-by", "next human work session")
      );
      break;
    case "accept":
      result = await recordAcceptance(
        root,
        one(parsed.flags, "actor"),
        one(parsed.flags, "note", "Recorded explicit scientific acceptance.")
      );
      break;
    case "resolve-block":
      result = await resolveBlocks(
        root,
        one(parsed.flags, "actor"),
        all(parsed.flags, "event"),
        one(parsed.flags, "note", "Recorded explicit block resolution.")
      );
      break;
    case "package":
      result = await packageHandoff(root, one(parsed.flags, "package"), all(parsed.flags, "file"));
      break;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
