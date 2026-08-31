import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DoctorReportSchema, runDoctor, type DoctorReport } from "../src/doctor.js";

const disposableRoots = new Set<string>();
const restoreWritable = new Set<string>();

afterEach(async () => {
  for (const target of restoreWritable) {
    await chmod(target, 0o700).catch(() => undefined);
  }
  restoreWritable.clear();
  await Promise.all(
    [...disposableRoots].map((root) => rm(root, { recursive: true, force: true }))
  );
  disposableRoots.clear();
});

async function temporaryDirectory(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "research-steward-doctor-")));
  disposableRoots.add(root);
  return root;
}

const SCHEMA_FILES = [
  "project-manifest.schema.json",
  "research-event.schema.json",
  "roundtable-plan.schema.json"
];

async function pluginFixture(): Promise<string> {
  const root = await temporaryDirectory();
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "cli.mjs"), "#!/usr/bin/env node\nconsole.log(1);\n");
  await writeFile(path.join(root, "dist", "server.mjs"), "console.log(2);\n");
  await mkdir(path.join(root, "schemas"));
  for (const name of SCHEMA_FILES) {
    await writeFile(path.join(root, "schemas", name), JSON.stringify({ title: name }));
  }
  for (let index = 0; index < 8; index += 1) {
    const skill = path.join(root, "skills", `skill-${index}`);
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), `# Skill ${index}\n`);
  }
  await writeFile(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { "research-steward": { command: "node" } } })
  );
  return root;
}

async function projectFixture(): Promise<string> {
  const root = await temporaryDirectory();
  await mkdir(path.join(root, ".research"));
  await writeFile(
    path.join(root, ".research", "manifest.json"),
    JSON.stringify({ protocol_version: "1.0", title: "Doctor fixture" })
  );
  return root;
}

const allFound = async (name: string): Promise<string | undefined> => `/fixture/bin/${name}`;
const noneFound = async (): Promise<string | undefined> => undefined;

function check(report: DoctorReport, id: string) {
  const found = report.checks.find((item) => item.id === id);
  expect(found, `expected check ${id} to exist`).toBeDefined();
  return found!;
}

describe("doctor report", () => {
  it("passes overall on a healthy plugin, project, and provider set", async () => {
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      projectRoot: await projectFixture(),
      env: {},
      execProbe: allFound
    });

    expect(DoctorReportSchema.parse(report)).toEqual(report);
    expect(report.protocol_version).toBe("1.0");
    expect(report.overall).toBe("pass");
    expect(report.checks.map((item) => item.id)).toEqual([
      "node.version",
      "bundle.dist",
      "schemas.public",
      "skills.inventory",
      "mcp.manifest",
      "project.root",
      "provider.qoder",
      "provider.qoder.auth",
      "provider.kimi",
      "provider.kimi.auth",
      "provider.grok",
      "provider.grok.auth",
      "http.token",
      "route.billing"
    ]);
    for (const id of [
      "node.version",
      "bundle.dist",
      "schemas.public",
      "skills.inventory",
      "mcp.manifest",
      "project.root",
      "provider.qoder",
      "provider.kimi",
      "provider.grok",
      "route.billing"
    ]) {
      expect(check(report, id).status, id).toBe("pass");
    }
    expect(check(report, "http.token").status).toBe("skipped");
    expect(check(report, "skills.inventory").summary).toContain("8");
  });

  it("reports provider basename only and never invokes an auth probe", async () => {
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      env: { RESEARCH_STEWARD_QODER_PATH: "/opt/custom/qoderclicn" },
      execProbe: async (name, explicit) => explicit ?? `/fixture/bin/${name}`
    });

    const qoder = check(report, "provider.qoder");
    expect(qoder.status).toBe("pass");
    expect(qoder.summary).toContain("qoderclicn");
    expect(qoder.summary).toContain("found");
    expect(qoder.summary).not.toContain("/opt/custom");

    for (const id of ["provider.qoder.auth", "provider.kimi.auth", "provider.grok.auth"]) {
      const auth = check(report, id);
      expect(auth.status).toBe("skipped");
      expect(auth.summary).not.toMatch(/logged in|authenticated/i);
      expect(auth.remediation).toMatch(/--help/);
    }
  });

  it("warns with remediation when a provider CLI is missing", async () => {
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      env: {},
      execProbe: async (name) => (name === "kimi" ? undefined : `/fixture/bin/${name}`)
    });

    const kimi = check(report, "provider.kimi");
    expect(kimi.status).toBe("warn");
    expect(kimi.remediation).toContain("RESEARCH_STEWARD_KIMI_PATH");
    expect(report.overall).toBe("warn");
  });

  it("fails project.root when the directory is not writable", async () => {
    const parent = await temporaryDirectory();
    const readOnly = path.join(parent, "frozen-project");
    await mkdir(readOnly, { mode: 0o500 });
    restoreWritable.add(readOnly);

    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      projectRoot: readOnly,
      env: {},
      execProbe: allFound
    });

    expect(check(report, "project.root").status).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  it("fails project.root when the protocol manifest is corrupt", async () => {
    const projectRoot = await temporaryDirectory();
    await mkdir(path.join(projectRoot, ".research"));
    await writeFile(path.join(projectRoot, ".research", "manifest.json"), "{ not json");

    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      projectRoot,
      env: {},
      execProbe: allFound
    });

    expect(check(report, "project.root").status).toBe("fail");
  });

  it("skips project.root when no project root is provided", async () => {
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      env: {},
      execProbe: allFound
    });
    expect(check(report, "project.root").status).toBe("skipped");
  });

  it("fails a placeholder HTTP token without echoing it anywhere", async () => {
    const token = "replace-me-token";
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      env: { RESEARCH_STEWARD_HTTP_TOKEN: token },
      execProbe: allFound
    });

    const httpToken = check(report, "http.token");
    expect(httpToken.status).toBe("fail");
    expect(httpToken.summary).toContain("does not meet strength policy");
    expect(JSON.stringify(report)).not.toContain(token);
    expect(report.overall).toBe("fail");
  });

  it("accepts a strong HTTP token and still never echoes it", async () => {
    const token = "0123456789abcdef".repeat(4);
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      env: { RESEARCH_STEWARD_HTTP_TOKEN: token },
      execProbe: allFound
    });

    expect(check(report, "http.token").status).toBe("pass");
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("skips http.token when the variable is unset", async () => {
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      env: {},
      execProbe: allFound
    });
    expect(check(report, "http.token").status).toBe("skipped");
  });

  it("warns on metered API keys by name only, never by value", async () => {
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      env: {
        XAI_API_KEY: "xai-super-secret-value-000",
        DEEPSEEK_API_KEY: "ds-super-secret-value-111"
      },
      execProbe: allFound
    });

    const billing = check(report, "route.billing");
    expect(billing.status).toBe("warn");
    expect(billing.summary).toContain("XAI_API_KEY");
    expect(billing.summary).toContain("DEEPSEEK_API_KEY");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("xai-super-secret-value-000");
    expect(serialized).not.toContain("ds-super-secret-value-111");
  });

  it("fails bundle.dist when a bundle file is missing and fail outranks warn", async () => {
    const pluginRoot = await pluginFixture();
    await rm(path.join(pluginRoot, "dist", "server.mjs"));

    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot,
      env: {},
      execProbe: noneFound
    });

    expect(check(report, "bundle.dist").status).toBe("fail");
    expect(check(report, "provider.grok").status).toBe("warn");
    expect(report.overall).toBe("fail");
  });

  it("grades Node.js 18 as warn and older majors as fail", async () => {
    const pluginRoot = await pluginFixture();
    const eighteen = await runDoctor({
      nodeVersion: "v18.19.0",
      pluginRoot,
      env: {},
      execProbe: allFound
    });
    expect(check(eighteen, "node.version").status).toBe("warn");
    expect(eighteen.overall).toBe("warn");

    const sixteen = await runDoctor({
      nodeVersion: "v16.20.0",
      pluginRoot,
      env: {},
      execProbe: allFound
    });
    expect(check(sixteen, "node.version").status).toBe("fail");
    expect(sixteen.overall).toBe("fail");
  });

  it("fails skills.inventory when fewer than eight skills carry SKILL.md", async () => {
    const pluginRoot = await pluginFixture();
    await rm(path.join(pluginRoot, "skills", "skill-7"), { recursive: true });

    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot,
      env: {},
      execProbe: allFound
    });

    const skills = check(report, "skills.inventory");
    expect(skills.status).toBe("fail");
    expect(skills.summary).toContain("7");
  });
});

describe("doctor fix round 1", () => {
  it("keeps a full report and downgrades provider checks to warn when the probe throws", async () => {
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      env: {},
      execProbe: async () => {
        throw new Error("EACCES: /Users/hidden-account/.secret/bin exploded");
      }
    });

    expect(DoctorReportSchema.parse(report)).toEqual(report);
    expect(report.checks).toHaveLength(14);
    for (const id of ["provider.qoder", "provider.kimi", "provider.grok"]) {
      const item = check(report, id);
      expect(item.status, id).toBe("warn");
      expect(item.summary).toMatch(/probe .*failed/);
    }
    expect(JSON.stringify(report)).not.toContain("hidden-account");
    expect(report.overall).toBe("warn");
  });

  it("skips http.token when the variable is set to an empty string", async () => {
    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      env: { RESEARCH_STEWARD_HTTP_TOKEN: "" },
      execProbe: allFound
    });
    expect(check(report, "http.token").status).toBe("skipped");
  });

  it("fails schemas.public when one schema file holds broken JSON", async () => {
    const pluginRoot = await pluginFixture();
    await writeFile(path.join(pluginRoot, "schemas", "research-event.schema.json"), "{ broken");

    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot,
      env: {},
      execProbe: allFound
    });

    const schemas = check(report, "schemas.public");
    expect(schemas.status).toBe("fail");
    expect(schemas.summary).toContain("research-event.schema.json");
  });

  it("fails project.root when it points to a regular file", async () => {
    const parent = await temporaryDirectory();
    const filePath = path.join(parent, "not-a-directory.txt");
    await writeFile(filePath, "plain file\n");

    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: await pluginFixture(),
      projectRoot: filePath,
      env: {},
      execProbe: allFound
    });

    expect(check(report, "project.root").status).toBe("fail");
  });

  it("fails mcp.manifest on broken JSON and on a missing server entry", async () => {
    const brokenRoot = await pluginFixture();
    await writeFile(path.join(brokenRoot, ".mcp.json"), "{ nope");
    const broken = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: brokenRoot,
      env: {},
      execProbe: allFound
    });
    expect(check(broken, "mcp.manifest").status).toBe("fail");

    const missingRoot = await pluginFixture();
    await writeFile(path.join(missingRoot, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    const missing = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot: missingRoot,
      env: {},
      execProbe: allFound
    });
    expect(check(missing, "mcp.manifest").status).toBe("fail");
  });

  it("warns when the Node.js version string cannot be parsed", async () => {
    const report = await runDoctor({
      nodeVersion: "not-a-version",
      pluginRoot: await pluginFixture(),
      env: {},
      execProbe: allFound
    });
    expect(check(report, "node.version").status).toBe("warn");
  });

  it("fails bundle.dist when a bundle file exists but is empty", async () => {
    const pluginRoot = await pluginFixture();
    await writeFile(path.join(pluginRoot, "dist", "server.mjs"), "");

    const report = await runDoctor({
      nodeVersion: "v22.4.0",
      pluginRoot,
      env: {},
      execProbe: allFound
    });
    expect(check(report, "bundle.dist").status).toBe("fail");
  });

  it("stays aligned with the server token strength predicate", async () => {
    const { isStrongHttpToken } = await import("../src/server.js");
    const pluginRoot = await pluginFixture();
    const samples = [
      "0123456789abcdef".repeat(4),
      "0123456789ABCDEF".repeat(4),
      "A".repeat(43),
      "-_" + "x".repeat(41),
      "replace-me-token",
      "deadbeef",
      "a".repeat(300),
      "PasswordPasswordPasswordPasswordPasswordPas"
    ];
    for (const token of samples) {
      const report = await runDoctor({
        nodeVersion: "v22.4.0",
        pluginRoot,
        env: { RESEARCH_STEWARD_HTTP_TOKEN: token },
        execProbe: allFound
      });
      const expected = isStrongHttpToken(token) ? "pass" : "fail";
      expect(check(report, "http.token").status, token.slice(0, 12)).toBe(expected);
    }
  });
});
