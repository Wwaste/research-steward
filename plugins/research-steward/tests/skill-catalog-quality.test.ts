import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadSkillCatalog,
  skillStackLock,
  validateSkillCatalog
} from "../src/skill-catalog.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(pluginRoot, "skills");

describe("skill catalog quality (Task 5.6)", () => {
  it("loads the on-disk catalog with content hashes", async () => {
    const catalog = await loadSkillCatalog(skillsRoot);
    expect(catalog.length).toBeGreaterThanOrEqual(16);
    for (const entry of catalog) {
      expect(entry.content_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  it("reports no blocking validation issues for shipped skills", async () => {
    const issues = await validateSkillCatalog(skillsRoot);
    const blocking = issues.filter((issue) =>
      ["SKILL_MD_MISSING", "SKILL_NAME_MISMATCH", "SKILL_BROKEN_LINK", "SKILL_VENDOR_STEERING"].includes(
        issue.code
      )
    );
    expect(blocking).toEqual([]);
  });

  it("builds a selection lock and reports missing ids", async () => {
    const catalog = await loadSkillCatalog(skillsRoot);
    const lock = skillStackLock(catalog, ["statistics-audit", "no-such-skill"]);
    expect(lock.selected).toHaveLength(1);
    expect(lock.missing).toEqual(["no-such-skill"]);
  });
});
