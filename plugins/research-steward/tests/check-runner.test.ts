import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeCheckRequest,
  defaultCheckPolicy,
  CheckPolicySchema
} from "../src/check-policy.js";
import { prepareAndRunCheck } from "../src/check-runner.js";
import { expectErrorCode, temporaryDirectory } from "./helpers.js";

const id = (p: string): string => p;

describe("check policy authorization (Task 3.4)", () => {
  it("rejects executables outside the allowlist", () => {
    const policy = defaultCheckPolicy(["true"]);
    expect(() =>
      authorizeCheckRequest(
        policy,
        { executable: "curl", argv: ["https://evil"] },
        "/tmp/project",
        id
      )
    ).toThrowError(expect.objectContaining({ code: "CHECK_EXECUTABLE_NOT_ALLOWED" }));
  });

  it("rejects cwd outside the project root", () => {
    const policy = defaultCheckPolicy(["true"]);
    expect(() =>
      authorizeCheckRequest(
        policy,
        { executable: "true", argv: [], cwd: "/etc" },
        "/tmp/project",
        id
      )
    ).toThrowError(expect.objectContaining({ code: "CHECK_CWD_OUTSIDE_ROOT" }));
  });

  it("rejects env keys not on allowed_env", () => {
    const policy = defaultCheckPolicy(["true"]);
    expect(() =>
      authorizeCheckRequest(
        policy,
        { executable: "true", argv: [], env: { AWS_SECRET_ACCESS_KEY: "x" } },
        "/tmp/project",
        id
      )
    ).toThrowError(expect.objectContaining({ code: "CHECK_ENV_NOT_ALLOWED" }));
  });

  it("treats shell metacharacters as literal argv (no interpolation)", () => {
    const policy = defaultCheckPolicy(["echo"]);
    expect(() =>
      authorizeCheckRequest(
        policy,
        { executable: "echo", argv: ["a;rm -rf /"] },
        "/tmp/project",
        id
      )
    ).not.toThrow();
  });

  it("rejects timeouts above policy", () => {
    const policy = CheckPolicySchema.parse({
      policy_version: 1,
      allowlist: ["true"],
      max_wall_time_ms: 1_000
    });
    expect(() =>
      authorizeCheckRequest(
        policy,
        { executable: "true", argv: [], timeout_ms: 60_000 },
        "/tmp/project",
        id
      )
    ).toThrowError(expect.objectContaining({ code: "CHECK_TIMEOUT_EXCEEDS_POLICY" }));
  });
});

describe("check runner spawn (Task 3.4)", () => {
  it("runs an allowlisted binary and returns hashes, not raw output", async () => {
    const root = await temporaryDirectory();
    const result = await prepareAndRunCheck({
      projectRoot: root,
      policy: defaultCheckPolicy(["/bin/echo"]),
      request: { executable: "/bin/echo", argv: ["hello-secret"] }
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.stdout_chars).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
    expect(Object.keys(result)).not.toContain("stdout_text");
  });

  it("does not run a disallowed executable", async () => {
    const root = await temporaryDirectory();
    await expectErrorCode(
      prepareAndRunCheck({
        projectRoot: root,
        policy: defaultCheckPolicy(["/bin/echo"]),
        request: { executable: "/bin/sh", argv: ["-c", "echo pwned"] }
      }),
      "CHECK_EXECUTABLE_NOT_ALLOWED"
    );
  });

  it("enforces wall-time timeout", async () => {
    const root = await temporaryDirectory();
    const result = await prepareAndRunCheck({
      projectRoot: root,
      policy: defaultCheckPolicy(["/bin/sleep"]),
      request: { executable: "/bin/sleep", argv: ["5"], timeout_ms: 200 }
    });
    expect(result.timed_out).toBe(true);
    expect(result.duration_ms).toBeLessThan(4_000);
  });

  it("keeps cwd inside the project root by default", async () => {
    const root = await temporaryDirectory();
    const result = await prepareAndRunCheck({
      projectRoot: root,
      policy: defaultCheckPolicy(["/bin/pwd"]),
      request: { executable: "/bin/pwd", argv: [] }
    });
    expect(path.resolve(result.cwd)).toBe(path.resolve(root));
  });
});
