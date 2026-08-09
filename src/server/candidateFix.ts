import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkbenchSettings } from "./settings.js";
import { buildManicEnv } from "./manicEnv.js";

export interface CandidateFixArgs {
  workspace: string;
  content: string;
  settings: WorkbenchSettings;
  engineOverride?: string;
  signal?: AbortSignal;
}

export interface CandidateFixResult {
  code: string;
  fixed: number;
  via: "engine" | "wasm";
}

export type CandidateFixer = (args: CandidateFixArgs) => Promise<CandidateFixResult | null>;

/**
 * Deterministic local auto-correct for AI candidates, tried before spending a
 * model repair round. The installed engine (`manic fix --safe --stdout`) is
 * preferred because it is always at least as new as the bundled WASM snapshot;
 * the WASM build of the same Rust autofix logic is the fallback when no engine
 * is installed. `--safe` / `include_removals=false` skips destructive
 * stray-token removals — this is the silent post-AI pass, not the editor's
 * Auto-fix button.
 */
export function createCandidateFixer(
  clientRoot: string,
  engineFix: (args: CandidateFixArgs) => Promise<CandidateFixResult | null> = runEngineFix,
): CandidateFixer {
  const wasmFix = createWasmFix(clientRoot);
  return async (args) => {
    const viaEngine = await engineFix(args).catch(() => null);
    if (viaEngine) return viaEngine;
    return wasmFix(args.content).catch(() => null);
  };
}

/** `manic fix --safe --stdout`: stdout carries the (possibly corrected) source. */
export async function runEngineFix(args: CandidateFixArgs): Promise<CandidateFixResult | null> {
  const directory = join(args.workspace, `.manic-workbench-fix-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const file = join(directory, "candidate.manic");
  try {
    await writeFile(file, args.content, { mode: 0o600 });
    const stdout = await spawnEngineFix(args, file);
    if (stdout === null || !stdout.trim()) return null;
    return { code: stdout, fixed: countChangedLines(args.content, stdout), via: "engine" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function spawnEngineFix(args: CandidateFixArgs, file: string): Promise<string | null> {
  const command = args.engineOverride || args.settings.enginePath || process.env.MANIC_BIN || "manic";
  return new Promise((resolve) => {
    const child = spawn(command, ["fix", "--safe", "--stdout", file], {
      cwd: args.workspace,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: buildManicEnv(args.settings),
    });
    let output = "";
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    };
    child.stdout.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-5 * 1024 * 1024); });
    child.once("error", () => resolve(null));
    child.once("close", (_exitCode, killSignal) => {
      if (args.signal?.aborted || killSignal) resolve(null);
      else resolve(output);
    });
    if (args.signal) {
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

interface WasmAutofixModule {
  default(input?: unknown): Promise<unknown>;
  autofix(source: string, includeRemovals: boolean, wrapLatex: boolean): string;
}

/** Loads the bundled browser WASM language service inside Node. */
export function createWasmFix(clientRoot: string): (content: string) => Promise<CandidateFixResult | null> {
  let modulePromise: Promise<WasmAutofixModule | null> | null = null;
  const load = () => modulePromise ??= (async () => {
    try {
      const wasm = await import(
        /* @vite-ignore */ pathToFileURL(join(clientRoot, "wasm", "manic_lang.js")).href
      ) as WasmAutofixModule;
      const bytes = await readFile(join(clientRoot, "wasm", "manic_lang_bg.wasm"));
      await wasm.default({ module_or_path: bytes });
      return wasm;
    } catch {
      return null;
    }
  })();
  return async (content) => {
    const wasm = await load();
    if (!wasm) return null;
    const result = JSON.parse(wasm.autofix(content, false, true)) as { code?: unknown; fixed?: unknown };
    if (typeof result.code !== "string") return null;
    const fixed = typeof result.fixed === "number" ? result.fixed : countChangedLines(content, result.code);
    return { code: result.code, fixed, via: "wasm" };
  };
}

function countChangedLines(before: string, after: string): number {
  if (before === after) return 0;
  const left = before.split("\n");
  const right = after.split("\n");
  let changed = Math.abs(left.length - right.length);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) changed += 1;
  }
  return Math.max(1, changed);
}
