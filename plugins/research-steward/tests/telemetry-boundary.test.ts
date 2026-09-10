import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SpanSchema, TelemetryRecorder, redact, type SpanInput } from "../src/telemetry.js";
import { expectErrorCode, temporaryDirectory } from "./helpers.js";

// Windows path shapes the POSIX-only home patterns used to walk straight past.
const WINDOWS_HOME = "C:\\Users\\Alice\\private-project\\result.txt";
const WINDOWS_HOME_FORWARD = "C:/Users/Alice/private-project/result.txt";
const UNC_HOME = "\\\\fileserver\\Users\\bob\\secret";
const UNC_SHARE = "\\\\fileserver\\lab-share\\carol\\draft.docx";

function spanInput(attributes: Record<string, unknown> = {}): SpanInput {
  return {
    trace_id: "0af7651916cd43dd8448eb211c80319c",
    span_id: "b7ad6b7169203331",
    name: "research.node.run",
    start_time_unix_nano: "1756600000000000000",
    end_time_unix_nano: "1756600001000000000",
    attributes
  };
}

describe("telemetry trace file boundary", () => {
  it("refuses to append through a symlinked spans.jsonl and leaves the target byte-identical", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "original bytes\n", "utf8");
    await symlink(victim, path.join(directory, "spans.jsonl"));

    const recorder = new TelemetryRecorder({ directory });
    await expectErrorCode(
      recorder.record(spanInput({ "research.node_id": "n1" })),
      "TELEMETRY_PATH_REJECTED"
    );

    expect(await readFile(victim, "utf8")).toBe("original bytes\n");
    // The rejected path is left exactly as found: no silent replacement either.
    expect((await lstat(path.join(directory, "spans.jsonl"))).isSymbolicLink()).toBe(true);
  });

  it("rejects a trace path swapped for a symlink between two appends", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "original bytes\n", "utf8");

    const recorder = new TelemetryRecorder({ directory });
    await recorder.record(spanInput({ "research.node_id": "n1" }));
    await rm(recorder.jsonlPath!);
    await symlink(victim, recorder.jsonlPath!);

    await expectErrorCode(
      recorder.record(spanInput({ "research.node_id": "n2" })),
      "TELEMETRY_PATH_REJECTED"
    );
    expect(await readFile(victim, "utf8")).toBe("original bytes\n");
  });

  it("rejects a spans.jsonl that is not a regular file", async () => {
    const directory = await temporaryDirectory();
    await mkdir(path.join(directory, "spans.jsonl"));

    const recorder = new TelemetryRecorder({ directory });
    await expectErrorCode(recorder.record(spanInput()), "TELEMETRY_PATH_REJECTED");
    expect(await readdir(path.join(directory, "spans.jsonl"))).toEqual([]);
  });

  it("rejects a symlinked telemetry directory instead of writing through it", async () => {
    const parent = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const directory = path.join(parent, "traces");
    await symlink(outside, directory);

    const recorder = new TelemetryRecorder({ directory });
    await expectErrorCode(recorder.record(spanInput()), "TELEMETRY_PATH_REJECTED");
    expect(await readdir(outside)).toEqual([]);
  });

  it("tightens a pre-existing group-readable spans.jsonl before appending to it", async () => {
    const directory = await temporaryDirectory();
    const tracePath = path.join(directory, "spans.jsonl");
    await writeFile(tracePath, '{"pre":"existing"}\n', "utf8");
    await chmod(tracePath, 0o644);

    const recorder = new TelemetryRecorder({ directory });
    await recorder.record(spanInput({ "research.node_id": "n1" }));

    expect((await stat(tracePath)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(tracePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    // Appended, never truncated: the pre-existing line is still the first one.
    expect(lines[0]).toBe('{"pre":"existing"}');
    expect(SpanSchema.parse(JSON.parse(lines[1]!)).attributes["research.node_id"]).toBe("n1");
  });

  it("refuses a telemetry directory owned by another user", async () => {
    const directory = await temporaryDirectory();
    const recorder = new TelemetryRecorder({ directory });
    // The fixture directory is ours, so the only deterministic way to reach
    // the ownership guard is to move the process's own idea of "us".
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(-1);
    try {
      await expectErrorCode(recorder.record(spanInput()), "TELEMETRY_PATH_REJECTED");
    } finally {
      getuid.mockRestore();
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it("tightens a pre-existing world-readable telemetry directory", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "traces");
    await mkdir(directory);
    await chmod(directory, 0o755);

    const recorder = new TelemetryRecorder({ directory });
    await recorder.record(spanInput({ "research.node_id": "n1" }));

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(recorder.jsonlPath!)).mode & 0o777).toBe(0o600);
  });
});

describe("redact on Windows path shapes", () => {
  it("redacts Windows home directories in both separator styles", () => {
    expect(redact(WINDOWS_HOME)).toBe("<redacted>\\private-project\\result.txt");
    expect(redact(WINDOWS_HOME)).not.toContain("Alice");
    expect(redact(WINDOWS_HOME_FORWARD)).not.toContain("Alice");
    expect(redact("c:\\users\\alice\\notes.md")).not.toContain("alice");
    // Already-escaped rendering of the same path, as it arrives inside logs.
    expect(redact("C:\\\\Users\\\\Alice\\\\result.txt")).not.toContain("Alice");
  });

  it("redacts UNC user paths including the host and share", () => {
    expect(redact(UNC_HOME)).toBe("<redacted>\\secret");
    expect(redact(UNC_HOME)).not.toContain("bob");
    expect(redact(UNC_SHARE)).toBe("<redacted>\\draft.docx");
    expect(redact(UNC_SHARE)).not.toContain("carol");
    expect(redact(UNC_SHARE)).not.toContain("fileserver");
  });

  it("redacts device-prefixed paths instead of reading the prefix as a host", () => {
    expect(redact("\\\\?\\C:\\Users\\Alice\\result.txt")).toBe("<redacted>\\result.txt");
    expect(redact("\\\\?\\UNC\\fileserver\\lab-share\\carol\\draft.docx")).toBe(
      "<redacted>\\draft.docx"
    );
  });

  it("leaves Windows paths that carry no user identity alone", () => {
    expect(redact("C:\\Program Files\\provider-cli\\bin")).toBe(
      "C:\\Program Files\\provider-cli\\bin"
    );
    expect(redact("D:\\shared\\datasets")).toBe("D:\\shared\\datasets");
    expect(redact("plain harmless value")).toBe("plain harmless value");
  });

  it("keeps Windows home paths out of the snapshot, the jsonl line, and the OTLP export", async () => {
    const directory = await temporaryDirectory();
    const recorder = new TelemetryRecorder({ directory });
    await recorder.record(
      spanInput({
        "research.provider": WINDOWS_HOME,
        "research.model": UNC_HOME,
        "research.status": `failed reading ${WINDOWS_HOME_FORWARD}`
      })
    );
    const exportPath = path.join(directory, "export.otlp.json");
    await recorder.exportOTLPFile(exportPath);

    const surfaces = [
      JSON.stringify(recorder.snapshot()),
      await readFile(recorder.jsonlPath!, "utf8"),
      await readFile(exportPath, "utf8")
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain("Alice");
      expect(surface).not.toContain("bob");
      expect(surface).not.toContain("Users");
      expect(surface).not.toContain("fileserver");
      expect(surface).toContain("<redacted>");
    }
  });
});
