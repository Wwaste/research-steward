import { describe, expect, it } from "vitest";
import {
  evidenceFingerprint,
  hashFileLineRange,
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
        cwd: "runs/check",
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
        cwd: "runs/check",
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

  it("fingerprints are stable for equal locators", () => {
    const a = parseEvidenceLocator({ kind: "doi", doi: "10.1234/xyz123" });
    const b = parseEvidenceLocator({ kind: "doi", doi: "10.1234/xyz123" });
    expect(evidenceFingerprint(a)).toBe(evidenceFingerprint(b));
    expect(evidenceFingerprint(a)).toMatch(/^[a-f0-9]{64}$/);
  });
});


describe("CR-M-065 evidence acceptance tests", () => {
  it("fingerprint is key-order independent (would fail JSON.stringify)", () => {
    const a = {
      kind: "dataset_record" as const,
      dataset_id: "ds",
      record_key: "k1",
      snapshot_sha256: "a".repeat(64)
    };
    const b = {
      snapshot_sha256: "a".repeat(64),
      record_key: "k1",
      dataset_id: "ds",
      kind: "dataset_record" as const
    };
    expect(evidenceFingerprint(a as never)).toBe(evidenceFingerprint(b as never));
  });

  it("hashFileLineRange: CRLF is not normalized", () => {
    const crlf = Buffer.from("a\r\nb\r\n", "utf8");
    const lf = Buffer.from("a\nb\n", "utf8");
    expect(hashFileLineRange(crlf, 1, 2)).not.toBe(hashFileLineRange(lf, 1, 2));
  });

  it("hashFileLineRange: last line without LF", () => {
    const buf = Buffer.from("one\ntwo", "utf8");
    expect(hashFileLineRange(buf, 2, 2)).toMatch(/^[a-f0-9]{64}$/);
    // different from line 2 with trailing LF
    const withLf = Buffer.from("one\ntwo\n", "utf8");
    expect(hashFileLineRange(buf, 2, 2)).not.toBe(hashFileLineRange(withLf, 2, 2));
  });

  it("hashFileLineRange: binary without LF is one line", () => {
    const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    expect(hashFileLineRange(bin, 1, 1)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashFileLineRange: out-of-range is fail-closed", () => {
    const buf = Buffer.from("only\n", "utf8");
    expect(() => hashFileLineRange(buf, 2, 2)).toThrowError(
      expect.objectContaining({ code: "EVIDENCE_LINE_RANGE_INVALID" })
    );
    expect(() => hashFileLineRange(buf, 0, 1)).toThrowError(
      expect.objectContaining({ code: "EVIDENCE_LINE_RANGE_INVALID" })
    );
  });
});
