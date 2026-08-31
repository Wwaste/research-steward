/**
 * Roundtable presets for the v0.2 planner (Task 1.3).
 *
 * Authority choice: these TypeScript constants are the single source of truth.
 * The JSON files under presets/ are generated from this module, and
 * tests/planner.test.ts asserts that every presets/<id>.json deep-equals the
 * matching constant here, so any drift between the two fails the test run
 * instead of silently forking the data.
 *
 * Every node template ships with the "fake" adapter as a placeholder; callers
 * bind real providers through buildPlan() overrides. Brief templates may use
 * the {{packet_id}} placeholder, which buildPlan() substitutes with the
 * concrete packet id.
 */

export type PresetAdapter = "kimi" | "qoder" | "grok" | "fake";
export type PresetVisibility = "shared" | "blind" | "private";
export type PresetMode = "open" | "blind" | "mixed";

export interface PresetLimits {
  readonly max_parallel: number;
  readonly max_wall_time_ms: number;
  readonly max_prompt_chars: number;
  readonly max_output_chars: number;
  readonly retry_limit: number;
  readonly max_failures: number;
}

export interface PresetNodeTemplate {
  readonly id: string;
  readonly actor_id: string;
  readonly role: string;
  readonly brief: string;
  readonly adapter: PresetAdapter;
  readonly depends_on: readonly string[];
  readonly visibility: PresetVisibility;
  readonly blind_group?: string;
  readonly can_adjudicate: boolean;
  readonly timeout_ms: number;
}

export interface RoundtablePreset {
  readonly preset_id: string;
  readonly preset_version: string;
  readonly title: string;
  readonly description: string;
  readonly mode: PresetMode;
  readonly limits: PresetLimits;
  readonly nodes: readonly PresetNodeTemplate[];
}

const PRESET_VERSION = "1.0.0";
const REVIEW_TIMEOUT_MS = 300_000;
const PRODUCE_TIMEOUT_MS = 600_000;
const ADJUDICATE_TIMEOUT_MS = 600_000;

/**
 * The eight built-in skills shipped with Research Steward v0.1. The names
 * come from the directories under skills/ at the repository root; the test
 * suite asserts this list stays in step with that directory.
 */
export const BUILT_IN_SKILL_IDS: readonly string[] = Object.freeze([
  "artifact-verification",
  "blind-peer-review",
  "evidence-adjudication",
  "handoff-packaging",
  "project-workspace",
  "research-shared",
  "research-steward",
  "roundtable-collaboration"
]);

const quickReview: RoundtablePreset = {
  preset_id: "quick-review",
  preset_version: PRESET_VERSION,
  title: "Quick review",
  description:
    "One reviewer reads the frozen packet, one adjudicator turns the findings into dispositions. The fastest complete loop.",
  mode: "open",
  limits: {
    max_parallel: 2,
    max_wall_time_ms: 900_000,
    max_prompt_chars: 120_000,
    max_output_chars: 60_000,
    retry_limit: 1,
    max_failures: 2
  },
  nodes: [
    {
      id: "reviewer",
      actor_id: "quick-reviewer",
      role: "reviewer",
      brief:
        "Review the frozen packet {{packet_id}} end to end. Judge whether every claim is supported by the evidence inside the packet, report concrete findings with severity and evidence locators, and say plainly what you could not verify.",
      adapter: "fake",
      depends_on: [],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "adjudicator",
      actor_id: "quick-adjudicator",
      role: "adjudicator",
      brief:
        "Read the reviewer's committed findings on packet {{packet_id}}, decide a disposition for each one, and give a rationale every time. Do not introduce new claims of your own.",
      adapter: "fake",
      depends_on: ["reviewer"],
      visibility: "shared",
      can_adjudicate: true,
      timeout_ms: ADJUDICATE_TIMEOUT_MS
    }
  ]
};

const blindTriad: RoundtablePreset = {
  preset_id: "blind-triad",
  preset_version: PRESET_VERSION,
  title: "Blind triad",
  description:
    "Three mutually blind reviewers work in parallel, then an adjudicator compares all three reports and settles every finding.",
  mode: "blind",
  limits: {
    max_parallel: 3,
    max_wall_time_ms: 1_800_000,
    max_prompt_chars: 120_000,
    max_output_chars: 60_000,
    retry_limit: 1,
    max_failures: 3
  },
  nodes: [
    {
      id: "blind-reviewer-1",
      actor_id: "triad-reviewer-1",
      role: "blind reviewer",
      brief:
        "You are one of three independent blind reviewers for packet {{packet_id}}. Work only from the packet contents, make no assumptions about what the other reviewers will say, and report findings with severity, evidence locators, and open uncertainties.",
      adapter: "fake",
      depends_on: [],
      visibility: "blind",
      blind_group: "triad",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "blind-reviewer-2",
      actor_id: "triad-reviewer-2",
      role: "blind reviewer",
      brief:
        "You are one of three independent blind reviewers for packet {{packet_id}}. Work only from the packet contents, make no assumptions about what the other reviewers will say, and report findings with severity, evidence locators, and open uncertainties.",
      adapter: "fake",
      depends_on: [],
      visibility: "blind",
      blind_group: "triad",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "blind-reviewer-3",
      actor_id: "triad-reviewer-3",
      role: "blind reviewer",
      brief:
        "You are one of three independent blind reviewers for packet {{packet_id}}. Work only from the packet contents, make no assumptions about what the other reviewers will say, and report findings with severity, evidence locators, and open uncertainties.",
      adapter: "fake",
      depends_on: [],
      visibility: "blind",
      blind_group: "triad",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "adjudicator",
      actor_id: "triad-adjudicator",
      role: "adjudicator",
      brief:
        "All three blind reviews of packet {{packet_id}} are committed. Compare them, adjudicate each finding with an explicit disposition and rationale, and surface disagreements between the reviewers instead of papering over them.",
      adapter: "fake",
      depends_on: ["blind-reviewer-1", "blind-reviewer-2", "blind-reviewer-3"],
      visibility: "shared",
      can_adjudicate: true,
      timeout_ms: ADJUDICATE_TIMEOUT_MS
    }
  ]
};

const fullPanel: RoundtablePreset = {
  preset_id: "full-panel",
  preset_version: PRESET_VERSION,
  title: "Full panel",
  description:
    "A producer drafts the deliverable, a methods reviewer and two blind panel reviewers assess it, and an adjudicator closes the loop.",
  mode: "mixed",
  limits: {
    max_parallel: 3,
    max_wall_time_ms: 2_700_000,
    max_prompt_chars: 150_000,
    max_output_chars: 60_000,
    retry_limit: 1,
    max_failures: 4
  },
  nodes: [
    {
      id: "producer",
      actor_id: "panel-producer",
      role: "producer",
      brief:
        "Produce the primary deliverable for packet {{packet_id}} as described in the packet brief. State your assumptions explicitly and attach evidence for every substantive claim.",
      adapter: "fake",
      depends_on: [],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: PRODUCE_TIMEOUT_MS
    },
    {
      id: "methods-reviewer",
      actor_id: "panel-methods-reviewer",
      role: "methods reviewer",
      brief:
        "Review the methodology behind the producer's contribution for packet {{packet_id}}: design, controls, statistics, and reproducibility. Report findings with severity and evidence.",
      adapter: "fake",
      depends_on: ["producer"],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "blind-reviewer-1",
      actor_id: "panel-blind-reviewer-1",
      role: "blind reviewer",
      brief:
        "You are one of two independent blind reviewers on the panel for packet {{packet_id}}. Assess the producer's contribution on its own merits, without seeing any other review, and report findings with severity and evidence.",
      adapter: "fake",
      depends_on: ["producer"],
      visibility: "blind",
      blind_group: "panel-blind",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "blind-reviewer-2",
      actor_id: "panel-blind-reviewer-2",
      role: "blind reviewer",
      brief:
        "You are one of two independent blind reviewers on the panel for packet {{packet_id}}. Assess the producer's contribution on its own merits, without seeing any other review, and report findings with severity and evidence.",
      adapter: "fake",
      depends_on: ["producer"],
      visibility: "blind",
      blind_group: "panel-blind",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "adjudicator",
      actor_id: "panel-adjudicator",
      role: "adjudicator",
      brief:
        "With the methods review and both blind panel reviews of packet {{packet_id}} committed, adjudicate every finding, record dispositions with rationales, and summarize what must change before acceptance.",
      adapter: "fake",
      depends_on: ["methods-reviewer", "blind-reviewer-1", "blind-reviewer-2"],
      visibility: "shared",
      can_adjudicate: true,
      timeout_ms: ADJUDICATE_TIMEOUT_MS
    }
  ]
};

const producerReviewerRevision: RoundtablePreset = {
  preset_id: "producer-reviewer-revision",
  preset_version: PRESET_VERSION,
  title: "Producer, reviewer, revision",
  description:
    "A strictly sequential chain: the producer drafts, the reviewer critiques, and the reviser addresses every finding in a revised draft.",
  mode: "open",
  limits: {
    max_parallel: 1,
    max_wall_time_ms: 1_800_000,
    max_prompt_chars: 120_000,
    max_output_chars: 60_000,
    retry_limit: 1,
    max_failures: 3
  },
  nodes: [
    {
      id: "producer",
      actor_id: "chain-producer",
      role: "producer",
      brief:
        "Draft the deliverable for packet {{packet_id}} following the packet brief. Make your assumptions explicit and cite packet evidence for each claim.",
      adapter: "fake",
      depends_on: [],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: PRODUCE_TIMEOUT_MS
    },
    {
      id: "reviewer",
      actor_id: "chain-reviewer",
      role: "reviewer",
      brief:
        "Review the producer's draft for packet {{packet_id}}. List concrete, actionable findings with severity, and keep matters of correctness separate from matters of style.",
      adapter: "fake",
      depends_on: ["producer"],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "reviser",
      actor_id: "chain-reviser",
      role: "reviser",
      brief:
        "Revise the draft for packet {{packet_id}} using the reviewer's findings. Address every finding explicitly: either fix it, or explain why the draft should stand as it is.",
      adapter: "fake",
      depends_on: ["producer", "reviewer"],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: PRODUCE_TIMEOUT_MS
    }
  ]
};

const manuscriptStrict: RoundtablePreset = {
  preset_id: "manuscript-strict",
  preset_version: PRESET_VERSION,
  title: "Manuscript strict",
  description:
    "The heavyweight manuscript pipeline: a producer, three mutually blind reviewers, a statistics reviewer, and a closing adjudicator.",
  mode: "mixed",
  limits: {
    max_parallel: 4,
    max_wall_time_ms: 3_600_000,
    max_prompt_chars: 200_000,
    max_output_chars: 80_000,
    retry_limit: 1,
    max_failures: 4
  },
  nodes: [
    {
      id: "producer",
      actor_id: "manuscript-producer",
      role: "producer",
      brief:
        "Prepare the manuscript deliverable for packet {{packet_id}} following the packet brief, attaching evidence to every substantive claim.",
      adapter: "fake",
      depends_on: [],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: PRODUCE_TIMEOUT_MS
    },
    {
      id: "blind-reviewer-1",
      actor_id: "manuscript-blind-reviewer-1",
      role: "blind reviewer",
      brief:
        "You are one of three independent blind reviewers of the manuscript for packet {{packet_id}}. Judge soundness, framing, and evidence support strictly from the packet, without seeing any other review, and report findings with severity.",
      adapter: "fake",
      depends_on: ["producer"],
      visibility: "blind",
      blind_group: "manuscript-blind",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "blind-reviewer-2",
      actor_id: "manuscript-blind-reviewer-2",
      role: "blind reviewer",
      brief:
        "You are one of three independent blind reviewers of the manuscript for packet {{packet_id}}. Judge soundness, framing, and evidence support strictly from the packet, without seeing any other review, and report findings with severity.",
      adapter: "fake",
      depends_on: ["producer"],
      visibility: "blind",
      blind_group: "manuscript-blind",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "blind-reviewer-3",
      actor_id: "manuscript-blind-reviewer-3",
      role: "blind reviewer",
      brief:
        "You are one of three independent blind reviewers of the manuscript for packet {{packet_id}}. Judge soundness, framing, and evidence support strictly from the packet, without seeing any other review, and report findings with severity.",
      adapter: "fake",
      depends_on: ["producer"],
      visibility: "blind",
      blind_group: "manuscript-blind",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "statistics-reviewer",
      actor_id: "manuscript-statistics-reviewer",
      role: "statistics reviewer",
      brief:
        "Audit the statistical reporting of the manuscript for packet {{packet_id}}: tests, sample sizes, replicates, corrections, and whether the numbers actually support the stated claims.",
      adapter: "fake",
      depends_on: ["producer"],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "adjudicator",
      actor_id: "manuscript-adjudicator",
      role: "adjudicator",
      brief:
        "All three blind reviews and the statistics audit for packet {{packet_id}} are committed. Adjudicate every finding with a disposition and rationale, and state the conditions for acceptance.",
      adapter: "fake",
      depends_on: [
        "blind-reviewer-1",
        "blind-reviewer-2",
        "blind-reviewer-3",
        "statistics-reviewer"
      ],
      visibility: "shared",
      can_adjudicate: true,
      timeout_ms: ADJUDICATE_TIMEOUT_MS
    }
  ]
};

const figureAudit: RoundtablePreset = {
  preset_id: "figure-audit",
  preset_version: PRESET_VERSION,
  title: "Figure audit",
  description:
    "A figure reviewer checks visual honesty, a provenance reviewer traces every figure to its source data, and an adjudicator settles the findings.",
  mode: "open",
  limits: {
    max_parallel: 2,
    max_wall_time_ms: 1_200_000,
    max_prompt_chars: 120_000,
    max_output_chars: 60_000,
    retry_limit: 1,
    max_failures: 3
  },
  nodes: [
    {
      id: "figure-reviewer",
      actor_id: "figure-audit-reviewer",
      role: "figure reviewer",
      brief:
        "Audit the figures in packet {{packet_id}} for accuracy and honesty: axes, scales, error bars, image processing, and whether each figure supports the claim its caption makes.",
      adapter: "fake",
      depends_on: [],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "provenance-reviewer",
      actor_id: "figure-provenance-reviewer",
      role: "provenance reviewer",
      brief:
        "Trace the provenance of every figure in packet {{packet_id}}: source data, generation scripts, and processing steps. Flag any figure whose origin cannot be established from the packet.",
      adapter: "fake",
      depends_on: [],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "adjudicator",
      actor_id: "figure-adjudicator",
      role: "adjudicator",
      brief:
        "Combine the figure audit and the provenance audit for packet {{packet_id}}, adjudicate each finding with a disposition and rationale, and list the figures that block acceptance.",
      adapter: "fake",
      depends_on: ["figure-reviewer", "provenance-reviewer"],
      visibility: "shared",
      can_adjudicate: true,
      timeout_ms: ADJUDICATE_TIMEOUT_MS
    }
  ]
};

const codeScienceAudit: RoundtablePreset = {
  preset_id: "code-science-audit",
  preset_version: PRESET_VERSION,
  title: "Code and science audit",
  description:
    "A code reviewer and a science reviewer examine the packet from their own angles, then an adjudicator reconciles the two reports.",
  mode: "open",
  limits: {
    max_parallel: 2,
    max_wall_time_ms: 1_800_000,
    max_prompt_chars: 150_000,
    max_output_chars: 60_000,
    retry_limit: 1,
    max_failures: 3
  },
  nodes: [
    {
      id: "code-reviewer",
      actor_id: "audit-code-reviewer",
      role: "code reviewer",
      brief:
        "Review the code in packet {{packet_id}} for correctness, reproducibility, and hidden assumptions that could change the scientific results.",
      adapter: "fake",
      depends_on: [],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "science-reviewer",
      actor_id: "audit-science-reviewer",
      role: "science reviewer",
      brief:
        "Review the scientific reasoning in packet {{packet_id}}: whether the methods answer the question, the analysis matches the design, and the conclusions stay within the evidence.",
      adapter: "fake",
      depends_on: [],
      visibility: "shared",
      can_adjudicate: false,
      timeout_ms: REVIEW_TIMEOUT_MS
    },
    {
      id: "adjudicator",
      actor_id: "audit-adjudicator",
      role: "adjudicator",
      brief:
        "Adjudicate the code review and the science review for packet {{packet_id}} together, resolve any conflicts between them, and record a disposition with rationale for each finding.",
      adapter: "fake",
      depends_on: ["code-reviewer", "science-reviewer"],
      visibility: "shared",
      can_adjudicate: true,
      timeout_ms: ADJUDICATE_TIMEOUT_MS
    }
  ]
};

export const PRESETS: Readonly<Record<string, RoundtablePreset>> = Object.freeze({
  "quick-review": quickReview,
  "blind-triad": blindTriad,
  "full-panel": fullPanel,
  "producer-reviewer-revision": producerReviewerRevision,
  "manuscript-strict": manuscriptStrict,
  "figure-audit": figureAudit,
  "code-science-audit": codeScienceAudit
});

export const PRESET_IDS: readonly string[] = Object.freeze(Object.keys(PRESETS));
