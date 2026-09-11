import { chmod, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckPolicyV2Schema } from "../src/command-policy.js";
import { createCheckDomain } from "../src/check-domain.js";
import { temporaryDirectory } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("check domain (DESIGN-COMMAND-DOMAIN)", () => {
  it("runs an authorized template and returns hashes only", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rs-cd-"));
    cleanup.push(dir);
    const bin = path.join(dir, "ok.sh");
    await (await import("node:fs/promises")).writeFile(
      bin,
      "#!/bin/sh\necho secret-output\nexit 0\n",
      "utf8"
    );
    await chmod(bin, 0o755);
    const root = await temporaryDirectory();
    const policy = CheckPolicyV2Schema.parse({
      policy_version: 2,
      templates: [
        {
          template_id: "t.ok",
          executable: bin,
          argv_pattern: []
        }
      ]
    });
    const domain = createCheckDomain(root, policy);
    const evidence = await domain.runPolicyCheck({ template_id: "t.ok", argv: [] });
    expect(evidence.exit_code).toBe(0);
    expect(evidence.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain("secret-output");
    expect(evidence.command_line_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
