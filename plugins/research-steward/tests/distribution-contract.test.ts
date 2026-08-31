import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = process.cwd();
const repoRoot = path.resolve(pluginRoot, "..", "..");

async function text(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

describe("distribution contract", () => {
  it("pins the stable Codex install to the v0.1.0 release tag", async () => {
    const readme = await text(path.join(repoRoot, "README.md"));
    expect(readme).toContain(
      "codex plugin marketplace add Wwaste/research-steward --ref v0.1.0"
    );
    expect(readme).not.toContain("--ref main");
    // The local development path keeps installing from the checkout itself.
    expect(readme).toContain("codex plugin marketplace add ../..");
  });

  it("describes v0.1.0 as released while keeping the API-stability caveat", async () => {
    const readme = await text(path.join(repoRoot, "README.md"));
    expect(readme).not.toMatch(/release candidate/i);
    expect(readme).toContain("v0.1.0 released");
    expect(readme).toContain("the public API may still change before v1.0");
  });

  it("declares a coverage toolchain aligned with the pinned vitest version", async () => {
    const pkg = JSON.parse(await text(path.join(pluginRoot, "package.json"))) as {
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.devDependencies.vitest).toBe("3.2.7");
    expect(pkg.devDependencies["@vitest/coverage-v8"]).toBe(pkg.devDependencies.vitest);
    expect(pkg.scripts["test:coverage"]).toBeDefined();
  });

  it("locks four numeric coverage thresholds in the vitest config", async () => {
    const config = (await import("../vitest.config.js")).default as {
      test?: { coverage?: { thresholds?: Record<string, unknown> } };
    };
    const thresholds = config.test?.coverage?.thresholds;
    expect(thresholds).toBeDefined();
    for (const key of ["statements", "branches", "functions", "lines"]) {
      expect(typeof thresholds?.[key], `coverage threshold ${key}`).toBe("number");
    }
  });

  it("ships a syntactically valid installed-plugin smoke script", async () => {
    const scriptPath = path.join(pluginRoot, "scripts", "smoke-installed-plugin.mjs");
    await stat(scriptPath);
    const checked = spawnSync(process.execPath, ["--check", scriptPath], {
      encoding: "utf8"
    });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it("separates CI into source tests, bundle identity, and installed smoke", async () => {
    const ci = await text(path.join(repoRoot, ".github", "workflows", "ci.yml"));
    expect(ci).toMatch(/source-tests/);
    expect(ci).toMatch(/rebuild-bundles/);
    expect(ci).toMatch(/bundle-identity/);
    // The identity diff is meaningful only after a rebuild in the same job.
    expect(ci.indexOf("rebuild-bundles")).toBeGreaterThan(-1);
    expect(ci.indexOf("bundle-identity")).toBeGreaterThan(ci.indexOf("rebuild-bundles"));
    expect(ci).toMatch(/installed-smoke/);
    expect(ci).toMatch(/test:coverage/);
    expect(ci).toMatch(/smoke-installed-plugin\.mjs/);
  });
});
