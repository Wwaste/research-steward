import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ResearchStewardError } from "./utils.js";

/**
 * Skill catalog metadata (Task 5.6, module layer). Quality gates validate
 * frontmatter and relative links; community stars are not an admission
 * criterion.
 */

export const SkillCatalogEntrySchema = z
  .object({
    skill_id: z.string().min(1).max(64),
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(2_000),
    stage: z.string().min(1).max(64).optional(),
    domain: z.string().min(1).max(64).optional(),
    license: z.string().min(1).max(100).default("Apache-2.0"),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    path: z.string().min(1).max(4_096)
  })
  .strict();

export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;

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

export async function loadSkillCatalog(skillsRoot: string): Promise<SkillCatalogEntry[]> {
  let dirs: string[] = [];
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    throw new ResearchStewardError(
      "SKILL_CATALOG_ROOT_MISSING",
      `skills root is missing or unreadable: ${skillsRoot}`
    );
  }
  const catalog: SkillCatalogEntry[] = [];
  for (const skillId of dirs.sort()) {
    const skillPath = path.join(skillsRoot, skillId, "SKILL.md");
    try {
      const info = await stat(skillPath);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    const body = await readFile(skillPath, "utf8");
    const meta = parseFrontmatter(body);
    catalog.push(
      SkillCatalogEntrySchema.parse({
        skill_id: skillId,
        name: meta.name ?? skillId,
        description: meta.description ?? "",
        content_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
        path: skillPath
      })
    );
  }
  return catalog;
}

export interface SkillValidationIssue {
  skill_id: string;
  code: string;
  message: string;
}

/** Frontmatter, relative links, and vendor-steering gates. */
export async function validateSkillDirectory(
  skillsRoot: string,
  skillId: string
): Promise<SkillValidationIssue[]> {
  const issues: SkillValidationIssue[] = [];
  const skillDir = path.join(skillsRoot, skillId);
  const skillPath = path.join(skillDir, "SKILL.md");
  let body: string;
  try {
    body = await readFile(skillPath, "utf8");
  } catch {
    return [
      {
        skill_id: skillId,
        code: "SKILL_MD_MISSING",
        message: "SKILL.md missing"
      }
    ];
  }
  const meta = parseFrontmatter(body);
  if (meta.name !== skillId) {
    issues.push({
      skill_id: skillId,
      code: "SKILL_NAME_MISMATCH",
      message: `frontmatter name "${meta.name ?? ""}" !== directory "${skillId}"`
    });
  }
  if ((meta.description ?? "").length < 20) {
    issues.push({
      skill_id: skillId,
      code: "SKILL_DESCRIPTION_SHORT",
      message: "description must be at least 20 characters"
    });
  }
  if (/buy now|subscribe today|discount code/i.test(body)) {
    issues.push({
      skill_id: skillId,
      code: "SKILL_VENDOR_STEERING",
      message: "vendor steering language detected"
    });
  }
  for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]!;
    if (/^https?:\/\//.test(target) || target.startsWith("#")) continue;
    const resolved = path.resolve(skillDir, target);
    try {
      await stat(resolved);
    } catch {
      issues.push({
        skill_id: skillId,
        code: "SKILL_BROKEN_LINK",
        message: `broken relative link: ${target}`
      });
    }
  }
  return issues;
}

export async function validateSkillCatalog(
  skillsRoot: string
): Promise<SkillValidationIssue[]> {
  const catalog = await loadSkillCatalog(skillsRoot);
  const issues: SkillValidationIssue[] = [];
  for (const entry of catalog) {
    issues.push(...(await validateSkillDirectory(skillsRoot, entry.skill_id)));
  }
  return issues;
}

export function skillStackLock(
  catalog: readonly SkillCatalogEntry[],
  selected: readonly string[]
): {
  lock_version: 1;
  selected: Array<{ skill_id: string; content_sha256: string }>;
  missing: string[];
} {
  const byId = new Map(catalog.map((entry) => [entry.skill_id, entry]));
  const missing: string[] = [];
  const locked: Array<{ skill_id: string; content_sha256: string }> = [];
  for (const id of selected) {
    const entry = byId.get(id);
    if (!entry) {
      missing.push(id);
      continue;
    }
    locked.push({ skill_id: id, content_sha256: entry.content_sha256 });
  }
  return { lock_version: 1, selected: locked, missing };
}
