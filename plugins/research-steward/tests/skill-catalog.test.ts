import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPECTED_MCP_TOOLS } from "../src/doctor.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(pluginRoot, "skills");

/** Task 3.3 focused scientific audit skills. */
const AUDIT_SKILLS = [
  "research-question-audit",
  "data-provenance-audit",
  "statistics-audit",
  "bias-validity-audit",
  "citation-integrity",
  "reproducibility-audit",
  "claim-evidence-audit",
  "reporting-guidelines"
] as const;

function parseFrontmatter(body: string): { name?: string; description?: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(body);
  if (!match) return {};
  const name = /^name:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim();
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description })
  };
}

describe("skill catalog (Task 3.3)", () => {
  it("ships the eight focused scientific audit skills with valid frontmatter", async () => {
    for (const id of AUDIT_SKILLS) {
      const skillPath = path.join(skillsRoot, id, "SKILL.md");
      const info = await stat(skillPath);
      expect(info.isFile(), `${id}/SKILL.md missing`).toBe(true);
      const body = await readFile(skillPath, "utf8");
      const meta = parseFrontmatter(body);
      expect(meta.name, `${id} frontmatter name`).toBe(id);
      expect(meta.description ?? "", `${id} description`).not.toBe("");
      expect(meta.description!.length).toBeGreaterThan(40);
      // Short route: no hidden CoT, no vendor upsell.
      expect(body).not.toMatch(/chain of thought|buy |subscribe now/i);
    }
  });

  it("keeps doctor's minimum skill count consistent with the catalog", async () => {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
    for (const id of AUDIT_SKILLS) {
      expect(directories).toContain(id);
    }
    expect(directories.length).toBeGreaterThanOrEqual(16);
    // Doctor inventory constant must not lag the disk.
    const doctorSource = await readFile(path.join(pluginRoot, "src", "doctor.ts"), "utf8");
    expect(doctorSource).toContain("MINIMUM_SKILL_DIRECTORIES = 16");
  });

  it("still advertises the same MCP tool inventory doctor checks", async () => {
    const serverSource = await readFile(path.join(pluginRoot, "src", "server.ts"), "utf8");
    for (const tool of EXPECTED_MCP_TOOLS) {
      expect(serverSource, `server.ts missing ${tool}`).toContain(`"${tool}"`);
    }
  });
});
