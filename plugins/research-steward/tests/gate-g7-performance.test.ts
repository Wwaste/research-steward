import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLedgerIndex, readEventsWithIndex } from "../src/ledger-index.js";
import { appendEvent, freezePacket, readEvents } from "../src/store.js";
import { initializedProject } from "./helpers.js";

/**
 * G7 / SUP-015: relative performance only — never absolute wall-clock
 * asserts (015 ruling). 10k full scale is heavier; this suite covers 200
 * events as a same-process relative smoke.
 */
describe("G7 relative performance smoke", () => {
  it(
    "200-event index build is not pathologically slower than plain readEvents",
    { timeout: 60_000 },
    async () => {
      const root = await initializedProject("g7");
      await writeFile(path.join(root, "n.md"), "x\n", "utf8");
      await freezePacket(root, "pkt-g7", ["n.md"]);
      for (let i = 0; i < 200; i += 1) {
        await appendEvent(root, {
          type: "candidate_declared",
          actor: { id: "g7", role: "author" },
          summary: `ev${i}`
        });
      }
      const t0 = Date.now();
      await readEvents(root);
      const plain = Date.now() - t0;
      const t1 = Date.now();
      await buildLedgerIndex(root, 50);
      const indexed = Date.now() - t1;
      // Relative bound with generous environment slack: index build may be
      // slower than one plain read but not 20x pathological.
      expect(indexed).toBeLessThanOrEqual(Math.max(plain * 20, 2000));
      await readEventsWithIndex(root);
    }
  );
});
