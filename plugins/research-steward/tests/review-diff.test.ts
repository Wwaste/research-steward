import { describe, expect, it } from "vitest";
import {
  classifyLocator,
  computeChangedFiles,
  diffPacketHash,
  DiffPacketSchema
} from "../src/review-diff.js";

const H = (c: string) => c.repeat(64);

describe("review-diff (DESIGN-EVIDENCE §4)", () => {
  it("classifies rename as untouched_remap (carry eligible)", () => {
    const changed = computeChangedFiles(
      { "old/a.md": H("a") },
      { "new/a.md": H("a") }
    );
    expect(changed).toEqual([
      expect.objectContaining({
        status: "renamed",
        path: "new/a.md",
        previous_path: "old/a.md"
      })
    ]);
    const cls = classifyLocator(
      { kind: "file_range", path: "old/a.md" },
      changed
    );
    expect(cls).toEqual({ untouched_remap: "new/a.md" });
  });

  it("binary content change is modified/touched", () => {
    const changed = computeChangedFiles(
      { "fig.png": H("a") },
      { "fig.png": H("b") }
    );
    expect(changed[0]!.status).toBe("modified");
    expect(classifyLocator({ kind: "artifact", path: "fig.png", file_sha256: H("b") }, changed)).toBe(
      "touched"
    );
  });

  it("line drift on modified file is touched (advisory only)", () => {
    const changed = computeChangedFiles(
      { "src/x.ts": H("a") },
      { "src/x.ts": H("b") }
    );
    expect(
      classifyLocator(
        { kind: "file_range", path: "src/x.ts", start_line: 1, end_line: 2 },
        changed
      )
    ).toBe("touched");
  });

  it("ambiguous rename degrades to delete+add and is not carry-eligible", () => {
    const changed = computeChangedFiles(
      { "a.txt": H("x"), "b.txt": H("x") },
      { "c.txt": H("x"), "d.txt": H("x") }
    );
    const statuses = changed.map((c) => c.status).sort();
    expect(statuses).toEqual(["added", "added", "deleted", "deleted"]);
    expect(classifyLocator({ kind: "file_range", path: "a.txt" }, changed)).toBe("touched");
  });

  it("url/doi/unstructured are unprovable", () => {
    expect(
      classifyLocator({ kind: "url", url: "https://e.org", retrieved_at: "2026-09-11T00:00:00.000Z", content_sha256: H("a") }, [])
    ).toBe("unprovable");
    expect(classifyLocator(null, [])).toBe("unprovable");
  });

  it("DiffPacket v1 includes roster and uuid review id", () => {
    const packet = DiffPacketSchema.parse({
      diff_version: 1,
      diff_review_id: "11111111-1111-4111-8111-111111111111",
      base_packet_id: "p1",
      base_packet_sha256: H("a"),
      target_packet_id: "p2",
      target_packet_sha256: H("b"),
      changed_files: [],
      roster: [
        {
          finding_event_id: "22222222-2222-4222-8222-222222222222",
          finding_id: "F1"
        }
      ],
      created_at: "2026-09-11T00:00:00.000Z"
    });
    expect(diffPacketHash(packet)).toMatch(/^[a-f0-9]{64}$/);
  });
});
