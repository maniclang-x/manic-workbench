import { spawn } from "node:child_process";
import type { WorkbenchSettings } from "./settings.js";
import { buildManicEnv } from "./manicEnv.js";

export interface EngineCheckResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export async function runEngineCheck(
  workspace: string,
  file: string,
  settings: WorkbenchSettings,
  engineOverride = "",
  signal?: AbortSignal,
): Promise<EngineCheckResult> {
  if (signal?.aborted) throw abortError();
  const command = engineOverride || settings.enginePath || process.env.MANIC_BIN || "manic";
  return new Promise<EngineCheckResult>((resolve, reject) => {
    const child = spawn(command, ["check", file], {
      cwd: workspace,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildManicEnv(settings),
    });
    let output = "";
    let settled = false;
    const collect = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-256 * 1024); };
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode, killSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted || killSignal === "SIGTERM" || killSignal === "SIGKILL") {
        reject(abortError());
        return;
      }
      resolve({
        ok: exitCode === 0,
        exitCode,
        output: output.trim() || (exitCode === 0 ? "Manic check completed successfully." : "Manic check failed without output."),
      });
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function abortError(): Error {
  const error = new Error("The Manic check was cancelled.");
  error.name = "AbortError";
  return error;
}
