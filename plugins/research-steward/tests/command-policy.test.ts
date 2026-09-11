import { describe, expect, it } from "vitest";
import {
  CheckPolicyV2Schema,
  assertEnvAllowed,
  authorizeTemplateRequest,
  isDenylistedEnvKey
} from "../src/command-policy.js";

const policy = CheckPolicyV2Schema.parse({
  policy_version: 2,
  templates: [
    {
      template_id: "test.echo",
      executable: "/bin/echo",
      argv_pattern: [{ kind: "literal", value: "hello" }],
      allow_trailing: { kind: "regex", pattern: "^[a-z]+$" }
    }
  ],
  allowed_env: ["MY_CUSTOM_VAR"]
});

describe("command policy v2 (DESIGN-COMMAND-DOMAIN)", () => {
  it("matches literal + trailing regex", () => {
    expect(() =>
      authorizeTemplateRequest(
        policy,
        { template_id: "test.echo", argv: ["hello", "world"] },
        "/tmp/p"
      )
    ).not.toThrow();
    expect(() =>
      authorizeTemplateRequest(
        policy,
        { template_id: "test.echo", argv: ["hello", "WORLD"] },
        "/tmp/p"
      )
    ).toThrowError(expect.objectContaining({ code: "CHECK_TEMPLATE_MISMATCH" }));
  });

  it("denylisted env wins over allowed_env (fail-closed)", () => {
    expect(isDenylistedEnvKey("LD_PRELOAD")).toBe(true);
    expect(() => assertEnvAllowed(policy, "LD_PRELOAD")).toThrowError(
      expect.objectContaining({ code: "CHECK_ENV_DENYLISTED" })
    );
    expect(() => assertEnvAllowed(policy, "PATH")).toThrowError(
      expect.objectContaining({ code: "CHECK_ENV_DENYLISTED" })
    );
    expect(() => assertEnvAllowed(policy, "AWS_SECRET")).toThrowError(
      expect.objectContaining({ code: "CHECK_ENV_NOT_ALLOWED" })
    );
  });
});
