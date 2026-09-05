import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const EVALS_ROOT = path.join(__dirname, "..", "evals");
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const HUMAN_CLAIM_PATTERN = /human[\s_-]*adjudicat/i;

async function evalCaseFiles(): Promise<string[]> {
  const files: string[] = [];
  const stack = [EVALS_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
    }
  }
  return files.sort();
}

describe("eval fixture provenance hygiene (RS-V1-SUP-013)", () => {
  it("finds at least the three smoke cases", async () => {
    expect((await evalCaseFiles()).length).toBeGreaterThanOrEqual(3);
  });

  it("rejects personal email addresses anywhere in committed eval fixtures", async () => {
    for (const file of await evalCaseFiles()) {
      const raw = await readFile(file, "utf8");
      expect(raw, `${path.basename(file)} must not contain an email address`).not.toMatch(
        EMAIL_PATTERN
      );
    }
  });

  it("rejects human-adjudication claims that carry no independent evidence records", async () => {
    for (const file of await evalCaseFiles()) {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as {
        provenance?: { adjudication_basis?: string; evidence_records?: unknown[] };
      };
      const basis = parsed.provenance?.adjudication_basis ?? "";
      // The leading marker is authoritative: an honest synthetic label may still
      // mention "human adjudication" in a negation ("NOT human-adjudicated").
      if (basis.startsWith("synthetic_expected_behavior:")) continue;
      if (HUMAN_CLAIM_PATTERN.test(basis)) {
        const records = parsed.provenance?.evidence_records;
        expect(
          Array.isArray(records) && records.length > 0,
          `${path.basename(file)} claims human adjudication but has no evidence_records; ` +
            `use "synthetic_expected_behavior: ..." until real annotation records exist`
        ).toBe(true);
      } else {
        expect.fail(
          `${path.basename(file)} adjudication_basis must start with ` +
            `"synthetic_expected_behavior:" or claim human adjudication with evidence_records`
        );
      }
    }
  });

  it("keeps fixture authors as role identifiers, never personal identities", async () => {
    for (const file of await evalCaseFiles()) {
      const parsed = JSON.parse(await readFile(file, "utf8")) as {
        provenance?: { author?: string };
      };
      const author = parsed.provenance?.author ?? "";
      expect(author, `${path.basename(file)} author must be a role id`).toMatch(
        /^[a-z0-9][a-z0-9-]{2,63}$/
      );
    }
  });
});
