import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRequiredAdapter,
  probeAllAdapters,
  probeDvc,
  probeMarimo,
  probeQuarto
} from "../src/repro-adapters.js";
import { temporaryDirectory } from "./helpers.js";

describe("repro adapters (Task 3.8)", () => {
  it("reports all adapters unavailable in an empty project without throwing", async () => {
    const root = await temporaryDirectory();
    const probes = await probeAllAdapters(root);
    expect(probes).toHaveLength(4);
    for (const probe of probes) expect(probe.available).toBe(false);
  });

  it("detects dvc.lock identity without spawning dvc", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "dvc.yaml"), "stages: {}\n", "utf8");
    await writeFile(path.join(root, "dvc.lock"), '{"outs":[]}\n', "utf8");
    const probe = await probeDvc(root);
    expect(probe.available).toBe(true);
    expect(probe.identity).toContain("dvc.lock");
  });

  it("detects marimo and quarto markers", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "nb.py"), "import marimo as mo\n", "utf8");
    await writeFile(path.join(root, "paper.qmd"), "# hi\n", "utf8");
    expect((await probeMarimo(root)).available).toBe(true);
    expect((await probeQuarto(root)).available).toBe(true);
  });

  it("assertRequiredAdapter fails closed only when required and missing", async () => {
    const root = await temporaryDirectory();
    const probes = await probeAllAdapters(root);
    expect(() => assertRequiredAdapter(probes, "dvc")).toThrowError(
      expect.objectContaining({ code: "OPTIONAL_ADAPTER_UNAVAILABLE" })
    );
    await writeFile(path.join(root, "dvc.yaml"), "stages: {}\n", "utf8");
    const after = await probeAllAdapters(root);
    expect(() => assertRequiredAdapter(after, "dvc")).not.toThrow();
  });
});
