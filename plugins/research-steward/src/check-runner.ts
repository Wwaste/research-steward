import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  authorizeCheckRequest,
  type CheckPolicy,
  type CheckRequest,
  type CheckResult
} from "./check-policy.js";
import { ResearchStewardError } from "./utils.js";

/**
 * Deterministic, policy-gated command runner. Spawns argv arrays with shell:
 * false, a minimal environment, a project-root cwd, and hard wall/output
 * limits. Raw stdout/stderr are never returned — only hashes and sizes — so
 * evidence locators stay stable and secrets in tool output cannot leak into
 * reports (Task 3.4).
 */

async function sha256(data: Buffer | string): Promise<string> {
  return createHash("sha256").update(data).digest("hex");
}

export interface RunCheckOptions {
  projectRoot: string;
  policy: CheckPolicy;
  request: CheckRequest;
  signal?: AbortSignal;
}

export async function prepareAndRunCheck(options: RunCheckOptions): Promise<CheckResult> {
  const realpathSyncCache = new Map<string, string>();
  const realpathOfSync = (p: string): string => {
    const hit = realpathSyncCache.get(p);
    if (hit !== undefined) return hit;
    throw new ResearchStewardError(
      "CHECK_REALPATH_REQUIRED",
      `Path must be pre-canonicalized before authorize: ${p}`,
      { path: p }
    );
  };

  const projectRoot = await realpath(options.projectRoot);
  const requestCwd =
    options.request.cwd === undefined ? projectRoot : await realpath(options.request.cwd);
  const prepared: CheckRequest = { ...options.request, cwd: requestCwd };
  realpathSyncCache.set(projectRoot, projectRoot);
  realpathSyncCache.set(requestCwd, requestCwd);
  for (const extra of options.policy.extra_cwd_roots) {
    try {
      realpathSyncCache.set(extra, await realpath(extra));
    } catch {
      // Missing extra roots are not usable.
    }
  }

  authorizeCheckRequest(options.policy, prepared, projectRoot, realpathOfSync);

  const timeoutMs = prepared.timeout_ms ?? options.policy.max_wall_time_ms;
  // CR-M-079: never inherit the caller PATH for spawned checks.
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: projectRoot,
    TMPDIR: projectRoot
  };
  for (const key of options.policy.allowed_env) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  for (const [key, value] of Object.entries(prepared.env ?? {})) {
    env[key] = value;
  }
  if (!options.policy.allow_network) {
    env["NO_PROXY"] = "*";
    env["no_proxy"] = "*";
  }

  const started = Date.now();
  return await new Promise<CheckResult>((resolve, reject) => {
    const child = spawn(prepared.executable, prepared.argv, {
      cwd: prepared.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const onChunk = (target: "out" | "err", chunk: Buffer): void => {
      const limit = options.policy.max_output_bytes;
      if (target === "out") {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= limit) stdoutChunks.push(chunk);
        else truncated = true;
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes <= limit) stderrChunks.push(chunk);
        else truncated = true;
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => onChunk("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => onChunk("err", chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref?.();
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        new ResearchStewardError(
          "CHECK_SPAWN_FAILED",
          `Could not start check executable: ${error.message}`
        )
      );
    });

    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      void sha256(stdout)
        .then(async (stdoutHash) => {
          const stderrHash = await sha256(stderr);
          resolve({
            check_version: 1,
            executable: prepared.executable,
            argv: prepared.argv,
            cwd: prepared.cwd!,
            exit_code: code ?? -1,
            signal: signal ?? null,
            timed_out: timedOut,
            stdout_sha256: stdoutHash,
            stderr_sha256: stderrHash,
            stdout_chars: stdout.length,
            stderr_chars: stderr.length,
            truncated,
            duration_ms: Date.now() - started
          });
        })
        .catch(reject);
    });
  });
}
