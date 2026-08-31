import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  CommittedEventSchema,
  ProjectManifestSchema,
  RoundtablePlanSchema
} from "./protocol.js";
import { DoctorReportSchema } from "./doctor.js";
import { WorkflowLockSchema } from "./planner.js";
import { ForecastSchema } from "./forecast.js";

type JsonObject = Record<string, unknown>;

function makeDefaultedPropertiesOptional(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(makeDefaultedPropertiesOptional);
  if (value === null || typeof value !== "object") return value;
  const source = value as JsonObject;
  const result = Object.fromEntries(
    Object.entries(source).map(([key, child]) => [key, makeDefaultedPropertiesOptional(child)])
  ) as JsonObject;
  const properties = result["properties"];
  const required = result["required"];
  if (
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Array.isArray(required)
  ) {
    const propertyMap = properties as JsonObject;
    result["required"] = required.filter((name) => {
      if (typeof name !== "string") return true;
      const property = propertyMap[name];
      return !(
        property !== null &&
        typeof property === "object" &&
        !Array.isArray(property) &&
        Object.hasOwn(property, "default")
      );
    });
  }
  return result;
}

function publicSchema(
  schema: z.ZodType,
  id: string,
  title: string,
  defaultsAreOptional = false
): JsonObject {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output"
  }) as JsonObject;
  const adjusted = defaultsAreOptional
    ? (makeDefaultedPropertiesOptional(generated) as JsonObject)
    : generated;
  return {
    ...adjusted,
    $id: `https://github.com/Wwaste/research-steward/schemas/${id}`,
    title
  };
}

export async function generateSchemas(): Promise<void> {
  const documents = [
    [
      "schemas/project-manifest.schema.json",
      publicSchema(
        ProjectManifestSchema,
        "project-manifest.schema.json",
        "Research Steward project manifest"
      )
    ],
    [
      "schemas/research-event.schema.json",
      publicSchema(
        CommittedEventSchema,
        "research-event.schema.json",
        "Research Steward immutable event"
      )
    ],
    [
      "schemas/roundtable-plan.schema.json",
      publicSchema(
        RoundtablePlanSchema,
        "roundtable-plan.schema.json",
        "Research Steward roundtable DAG plan",
        true
      )
    ]
    ,[
      "schemas/doctor-report.schema.json",
      publicSchema(
        DoctorReportSchema,
        "doctor-report.schema.json",
        "Research Steward doctor report"
      )
    ],
    [
      "schemas/workflow-lock.schema.json",
      publicSchema(
        WorkflowLockSchema,
        "workflow-lock.schema.json",
        "Research Steward workflow lock"
      )
    ],
    [
      "schemas/forecast.schema.json",
      publicSchema(
        ForecastSchema,
        "forecast.schema.json",
        "Research Steward dry-run forecast",
        true
      )
    ]
  ] as const;
  await Promise.all(
    documents.map(([filePath, document]) =>
      writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8")
    )
  );
}
