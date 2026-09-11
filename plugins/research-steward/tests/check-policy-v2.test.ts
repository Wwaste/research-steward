import { describe, expect, it } from "vitest";
import {
  CheckPolicyAnySchema,
  CheckPolicyV2Schema,
  matchArgPattern,
  authorizeTemplateRequest
} from "../src/check-policy.js";
import { temporaryDirectory } from "./helpers.js";

describe("check-policy v2 union (CR-M-064 redo)", () => {
  it("discriminated union accepts v1 and v2", () => {
    const v1 = CheckPolicyAnySchema.parse({
      policy_version: 1,
      allowlist: ["/bin/true"]
    });
    expect(v1.policy_version).toBe(1);
    const v2 = CheckPolicyV2Schema.parse({
      policy_version: 2,
      templates: [
        { template_id: "t", executable: "/bin/true", argv_pattern: [] }
      ]
    });
    expect(v2.policy_version).toBe(2);
  });

  it("path pattern rejects traversal and absolute", async () => {
    const root = await temporaryDirectory();
    expect(matchArgPattern({ kind: "path", within: "project_root" }, "../x", root)).toBe(false);
    expect(matchArgPattern({ kind: "path", within: "project_root" }, "/etc/passwd", root)).toBe(false);
    expect(matchArgPattern({ kind: "path", within: "project_root" }, "ok/file.txt", root)).toBe(true);
  });

  it("regex rejects nested quantifier bombs", async () => {
    const root = await temporaryDirectory();
    expect(
      matchArgPattern({ kind: "regex", pattern: "(a+)+" }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", root)
    ).toBe(false);
    expect(matchArgPattern({ kind: "regex", pattern: "^ok$" }, "ok", root)).toBe(true);
  });

  it("authorize requires template match", async () => {
    const root = await temporaryDirectory();
    const policy = CheckPolicyV2Schema.parse({
      policy_version: 2,
      templates: [
        { template_id: "t", executable: "/bin/echo", argv_pattern: [{ kind: "literal", value: "hi" }] }
      ]
    });
    expect(() =>
      authorizeTemplateRequest(policy, { template_id: "t", argv: ["hi"] }, root)
    ).not.toThrow();
    expect(() =>
      authorizeTemplateRequest(policy, { template_id: "t", argv: ["bye"] }, root)
    ).toThrowError(expect.objectContaining({ code: "CHECK_TEMPLATE_MISMATCH" }));
  });
});
