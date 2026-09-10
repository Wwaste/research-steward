import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoPathEscape,
  evidenceFingerprint,
  parseEvidenceLocator,
  tryUpgradeFreeText,
  upgradeOrKeepFreeText
} from "../src/evidence.js";

const H = "a".repeat(64);

describe("evidence locators (Task 3.2)", () => {
  it("parses each discriminated kind", () => {
    expect(
      parseEvidenceLocator({ kind: "file_range", path: "notes.md", start_line: 1, end_line: 3 })
        .kind
    ).toBe("file_range");
    expect(parseEvidenceLocator({ kind: "artifact", path: "fig.png", file_sha256: H }).kind).toBe(
      "artifact"
    );
    expect(
      parseEvidenceLocator({
        kind: "command_result",
        executable: "node",
        argv: ["-v"],
        cwd: "/project",
        exit_code: 0,
        stdout_sha256: H,
        stderr_sha256: H
      }).kind
    ).toBe("command_result");
    expect(
      parseEvidenceLocator({
        kind: "url",
        url: "https://example.org/a",
        retrieved_at: "2026-09-10T00:00:00.000Z",
        content_sha256: H
      }).kind
    ).toBe("url");
    expect(parseEvidenceLocator({ kind: "doi", doi: "10.1000/xyz" }).kind).toBe("doi");
    expect(
      parseEvidenceLocator({ kind: "dataset_record", dataset_id: "d1", record_key: "r1" }).kind
    ).toBe("dataset_record");
  });

  it("allows literal shell metacharacters in argv (no shell)", () => {
    expect(() =>
      parseEvidenceLocator({
        kind: "command_result",
        executable: "sh",
        argv: ["-c", "echo hi; rm -rf /"],
        cwd: "/project",
        exit_code: 0,
        stdout_sha256: H,
        stderr_sha256: H
      })
    ).not.toThrow();
  });

  it("upgrades only obvious file paths from free text and keeps the rest legacy", () => {
    expect(tryUpgradeFreeText("results/table1.csv")?.kind).toBe("file_range");
    expect(tryUpgradeFreeText("results/table1.csv:10-20")?.kind).toBe("file_range");
    expect(tryUpgradeFreeText("see the methods section around page 3")).toBeNull();
    const kept = upgradeOrKeepFreeText("see the methods section around page 3");
    expect(kept).toMatchObject({ kind: "free_text", legacy: true });
  });

  it("detects path escape", () => {
    const root = path.resolve("/tmp/project-root");
    expect(() => assertNoPathEscape(root, "notes.md")).not.toThrow();
    expect(() => assertNoPathEscape(root, "../secrets")).toThrowError(
      expect.objectContaining({ code: "EVIDENCE_PATH_ESCAPE" })
    );
    expect(() => assertNoPathEscape(root, "/etc/passwd")).toThrowError(
      expect.objectContaining({ code: "EVIDENCE_PATH_ESCAPE" })
    );
  });

  it("fingerprints are stable for equal locators", () => {
    const a = parseEvidenceLocator({ kind: "doi", doi: "10.1/x" });
    const b = parseEvidenceLocator({ kind: "doi", doi: "10.1/x" });
    expect(evidenceFingerprint(a)).toBe(evidenceFingerprint(b));
    expect(evidenceFingerprint(a)).toMatch(/^[a-f0-9]{64}$/);
  });
});
