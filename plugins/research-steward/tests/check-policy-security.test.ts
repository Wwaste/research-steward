import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckPolicyV2Schema, loadCheckPolicy, matchArgPattern } from "../src/check-policy.js";
import { createCheckDomain } from "../src/check-domain.js";
import { temporaryDirectory } from "./helpers.js";

describe("check-policy security (CR-M-079/080/081/082)", () => {
  it("executes only the resolved allowlist binary, not a PATH-injected impostor (CR-M-079)", async () => {
    const safeBin = await temporaryDirectory();
    const evilDir = await temporaryDirectory();
    const marker = path.join(evilDir, "pwned");
    const evil = path.join(evilDir, "echo");
    await writeFile(evil, `#!/bin/sh\necho pwned > '${marker}'\necho evil\n`, "utf8");
    await chmod(evil, 0o755);
    const safe = path.join(safeBin, "echo");
    await writeFile(safe, "#!/bin/sh\necho safe\n", "utf8");
    await chmod(safe, 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${evilDir}:${process.env.PATH ?? ""}`;
    try {
      const root = await temporaryDirectory();
      const policy = CheckPolicyV2Schema.parse({
        policy_version: 2,
        templates: [
          {
            template_id: "t.echo",
            executable: "echo",
            argv_pattern: []
          }
        ],
        path_dirs: [safeBin]
      });
      const domain = createCheckDomain(root, policy);
      const evidence = await domain.runPolicyCheck({ template_id: "t.echo", argv: [] });
      // marker must not exist: evil PATH entry never executed
      const { readFile } = await import("node:fs/promises");
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const { realpath } = await import("node:fs/promises");
      expect(evidence.executable).toBe(await realpath(safe));
      expect(path.isAbsolute(evidence.executable)).toBe(true);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  it("rejects a dangling symlink path argument regardless of target existence (CR-M-080)", async () => {
    const root = await temporaryDirectory();
    const managed = await temporaryDirectory();
    const outside = path.join(managed, "no-such-target-080");
    const link = path.join(root, "link.txt");
    await symlink(outside, link);
    expect(matchArgPattern({ kind: "path", within: "project_root" }, "link.txt", root)).toBe(false);
    await writeFile(outside, "now exists\n", "utf8");
    expect(matchArgPattern({ kind: "path", within: "project_root" }, "link.txt", root)).toBe(false);
  });

  it("regex compile refine rejects invalid and nested quantifiers (CR-M-081)", () => {
    expect(() =>
      CheckPolicyV2Schema.parse({
        policy_version: 2,
        templates: [
          { template_id: "t", executable: "/usr/bin/true", argv_pattern: [{ kind: "regex", pattern: "(" }] }
        ]
      })
    ).toThrow();
    expect(() =>
      CheckPolicyV2Schema.parse({
        policy_version: 2,
        templates: [
          { template_id: "t", executable: "/usr/bin/true", argv_pattern: [{ kind: "regex", pattern: "(a+)+$" }] }
        ]
      })
    ).toThrow();
  });

  it("loadCheckPolicy parses v1 and v2 (CR-M-082)", () => {
    expect(loadCheckPolicy({ policy_version: 1, allowlist: ["/usr/bin/true"] })).toMatchObject({
      policy_version: 1
    });
    expect(
      loadCheckPolicy({
        policy_version: 2,
        templates: [{ template_id: "t", executable: "/usr/bin/true", argv_pattern: [] }]
      })
    ).toMatchObject({ policy_version: 2 });
  });
});


describe("CR-M-084 path_dirs realpath fence", () => {
  it("rejects a path_dirs symlink that escapes to an outside impostor", async () => {
    const safeBin = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const impostor = path.join(outside, "echo");
    await writeFile(impostor, "#!/bin/sh\necho pwned\n", "utf8");
    await chmod(impostor, 0o755);
    await symlink(impostor, path.join(safeBin, "echo"));
    const root = await temporaryDirectory();
    const policy = CheckPolicyV2Schema.parse({
      policy_version: 2,
      templates: [{ template_id: "t", executable: "echo", argv_pattern: [] }],
      path_dirs: [safeBin]
    });
    const domain = createCheckDomain(root, policy);
    await expect(
      domain.runPolicyCheck({ template_id: "t", argv: [] })
    ).rejects.toMatchObject({ code: "CHECK_EXECUTABLE_UNRESOLVED" });
  });

  it("accepts a non-symlink binary inside path_dirs", async () => {
    const safeBin = await temporaryDirectory();
    const safe = path.join(safeBin, "echo");
    await writeFile(safe, "#!/bin/sh\necho ok\n", "utf8");
    await chmod(safe, 0o755);
    const root = await temporaryDirectory();
    const policy = CheckPolicyV2Schema.parse({
      policy_version: 2,
      templates: [{ template_id: "t", executable: "echo", argv_pattern: [] }],
      path_dirs: [safeBin]
    });
    const domain = createCheckDomain(root, policy);
    const evidence = await domain.runPolicyCheck({ template_id: "t", argv: [] });
    expect(evidence.exit_code).toBe(0);
  });
});


describe("CR-M-085 PATH denylist", () => {
  it("V2 schema rejects PATH in allowed_env", () => {
    expect(() =>
      CheckPolicyV2Schema.parse({
        policy_version: 2,
        templates: [{ template_id: "t", executable: "/usr/bin/true", argv_pattern: [] }],
        allowed_env: ["PATH"]
      })
    ).toThrow();
  });

  it("runner never inherits denylisted allowed_env keys (subprocess PATH marker)", async () => {
    const root = await temporaryDirectory();
    const marker = path.join(root, "path-marker.txt");
    // Child writes its own PATH so we can assert what it actually received.
    const script = path.join(root, "echo-path.sh");
    await writeFile(script, `#!/bin/sh\necho "$PATH" > '${marker}'\n`, "utf8");
    await chmod(script, 0o755);
    const { prepareAndRunCheck } = await import("../src/check-runner.js");
    const prevPath = process.env.PATH;
    process.env.PATH = "/evil/bin:/usr/bin";
    try {
      await prepareAndRunCheck({
        projectRoot: root,
        policy: {
          policy_version: 1,
          allowlist: [script],
          allow_network: false,
          max_wall_time_ms: 5000,
          max_output_bytes: 10240,
          max_concurrency: 1,
          allowed_env: ["PATH"],
          extra_cwd_roots: []
        },
        request: { executable: script, argv: [] }
      });
      const { readFile: rf } = await import("node:fs/promises");
      const seen = await rf(marker, "utf8");
      // Must be the runner-controlled PATH, not the caller's.
      expect(seen.trim()).toBe("/usr/bin:/bin");
      expect(seen).not.toContain("/evil/bin");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});
