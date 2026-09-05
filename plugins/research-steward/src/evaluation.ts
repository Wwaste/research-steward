import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ResearchStewardError } from "./utils.js";

// Offline evaluation harness for Research Steward roundtable runs. This module
// is pure bookkeeping: it loads hand-adjudicated gold cases and scores an
// already-recorded run against them. It never invokes a model, a provider
// adapter, or the workflow engine.

const IdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const EvalCaseSchema = z
  .object({
    case_id: IdentifierSchema,
    description: z.string().min(1).max(2_000),
    input: z
      .object({
        // Only the deterministic fake adapter is admissible in committed
        // cases, so replaying them costs nothing and needs no credentials.
        kind: z.literal("fake_roundtable"),
        plan: z.unknown()
      })
      .strict(),
    expected: z
      .object({
        findings: z
          .array(
            z
              .object({
                id: z.string().min(1).max(200),
                must_flag: z.boolean()
              })
              .strict()
          )
          .min(1)
          .max(200),
        acceptable_dispositions: z.record(
          z.string().min(1).max(200),
          z.array(z.string().min(1).max(50)).min(1).max(10)
        ),
        // Findings a human adjudicator declared genuinely undecidable. They
        // are excluded from every confusion-matrix count so a run is neither
        // rewarded nor punished for them.
        undecidable: z.array(z.string().min(1).max(200)).max(200).optional()
      })
      .strict(),
    provenance: z
      .object({
        author: z.string().min(1).max(200),
        created_at: z.string().datetime({ offset: true }),
        // Who or what adjudicated the gold labels. Must be a human or
        // independent evidence, never the model under evaluation.
        adjudication_basis: z.string().min(1).max(2_000)
      })
      .strict()
  })
  .strict();

export type EvalCase = z.infer<typeof EvalCaseSchema>;

export async function loadEvalCases(directory: string): Promise<EvalCase[]> {
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new ResearchStewardError(
      "EVAL_NO_CASES",
      `No .json eval cases found in ${directory}.`
    );
  }
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const filePath = path.join(directory, file);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      throw new ResearchStewardError(
        "EVAL_CASE_INVALID",
        `Eval case ${file} is not valid JSON.`,
        { file, reason: error instanceof Error ? error.message : String(error) }
      );
    }
    const parsed = EvalCaseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ResearchStewardError(
        "EVAL_CASE_INVALID",
        `Eval case ${file} does not match EvalCaseSchema.`,
        { file, issues: parsed.error.issues }
      );
    }
    if (seen.has(parsed.data.case_id)) {
      throw new ResearchStewardError(
        "EVAL_CASE_DUPLICATE",
        `Duplicate case_id ${parsed.data.case_id} in ${file}.`,
        { file }
      );
    }
    seen.add(parsed.data.case_id);
    cases.push(parsed.data);
  }
  return cases;
}

export interface EvalRunResult {
  flagged: string[];
  dispositions: Record<string, string>;
}

export interface EvalCaseScore {
  case_id: string;
  result_missing: boolean;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  true_negatives: number;
  missed: string[];
  unlabeled_flagged: string[];
  undecidable_excluded: string[];
  disposition_total: number;
  disposition_matches: number;
  disposition_mismatches: string[];
}

export interface EvalScore {
  per_case: EvalCaseScore[];
  precision: number | null;
  recall: number | null;
  fnr: number | null;
  fpr: number | null;
  missed: Array<{ case_id: string; finding_id: string }>;
  notes: string[];
  // Scoring is a pure function of (cases, results); there is no sampling and
  // therefore no "unstable" component, encoded here as an impossible field.
  unstable?: never;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function scoreEvalRun(
  cases: readonly EvalCase[],
  results: Readonly<Record<string, EvalRunResult>>
): EvalScore {
  const perCase: EvalCaseScore[] = [];
  const missed: Array<{ case_id: string; finding_id: string }> = [];
  const notes: string[] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (const evalCase of cases) {
    const result = results[evalCase.case_id];
    const flagged = new Set(result?.flagged ?? []);
    const dispositions = result?.dispositions ?? {};
    const undecidable = new Set(evalCase.expected.undecidable ?? []);
    const labeled = new Set<string>();
    const score: EvalCaseScore = {
      case_id: evalCase.case_id,
      result_missing: result === undefined,
      true_positives: 0,
      false_positives: 0,
      false_negatives: 0,
      true_negatives: 0,
      missed: [],
      unlabeled_flagged: [],
      undecidable_excluded: [...undecidable].sort(),
      disposition_total: 0,
      disposition_matches: 0,
      disposition_mismatches: []
    };
    if (result === undefined) {
      notes.push(
        `Case ${evalCase.case_id} has no recorded result; it is scored as an all-miss run.`
      );
    }

    for (const finding of evalCase.expected.findings) {
      labeled.add(finding.id);
      if (undecidable.has(finding.id)) {
        continue;
      }
      const wasFlagged = flagged.has(finding.id);
      if (finding.must_flag && wasFlagged) {
        score.true_positives += 1;
      } else if (finding.must_flag && !wasFlagged) {
        score.false_negatives += 1;
        score.missed.push(finding.id);
        missed.push({ case_id: evalCase.case_id, finding_id: finding.id });
      } else if (!finding.must_flag && wasFlagged) {
        score.false_positives += 1;
      } else {
        score.true_negatives += 1;
      }
    }

    // Flags on ids the gold labels never mention are reported but excluded
    // from the confusion matrix: without a label they are not adjudicable.
    score.unlabeled_flagged = [...flagged].filter((id) => !labeled.has(id)).sort();

    for (const [findingId, accepted] of Object.entries(
      evalCase.expected.acceptable_dispositions
    )) {
      if (undecidable.has(findingId)) {
        continue;
      }
      score.disposition_total += 1;
      const actual = dispositions[findingId];
      if (actual !== undefined && accepted.includes(actual)) {
        score.disposition_matches += 1;
      } else {
        score.disposition_mismatches.push(findingId);
      }
    }
    score.disposition_mismatches.sort();

    tp += score.true_positives;
    fp += score.false_positives;
    fn += score.false_negatives;
    tn += score.true_negatives;
    perCase.push(score);
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const fnr = ratio(fn, fn + tp);
  const fpr = ratio(fp, fp + tn);
  if (precision === null) {
    notes.push("precision is null: nothing labeled was flagged (insufficient sample).");
  }
  if (recall === null || fnr === null) {
    notes.push("recall/fnr are null: no must-flag findings in scope (insufficient sample).");
  }
  if (fpr === null) {
    notes.push("fpr is null: no negative-labeled findings in scope (insufficient sample).");
  }

  return { per_case: perCase, precision, recall, fnr, fpr, missed, notes };
}
