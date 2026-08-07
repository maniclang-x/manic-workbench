import { spawn } from "node:child_process";
import { discoverInstalledManic } from "./enginePaths.js";
import { buildManicEnv } from "./manicEnv.js";
import type { WorkbenchSettings } from "./settings.js";

export interface ToolVersion {
  available: boolean;
  command: string;
  version: string | null;
  detail: string | null;
}

export interface Diagnostics {
  engine: ToolVersion;
  ffmpeg: ToolVersion;
}

export async function collectDiagnostics(settingsOrPath: WorkbenchSettings | string): Promise<Diagnostics> {
  const settings = typeof settingsOrPath === "string"
    ? { enginePath: settingsOrPath, engineEnv: {} as Record<string, string> }
    : settingsOrPath;
  const explicit = settings.enginePath.trim() || process.env.MANIC_BIN?.trim() || "";
  const discovered = explicit ? null : await discoverInstalledManic();
  const engineCommand = explicit || discovered || "manic";
  const env = buildManicEnv(settings);
  const [engine, ffmpeg] = await Promise.all([
    inspectTool(engineCommand, ["version"], env),
    inspectTool("ffmpeg", ["-version"]),
  ]);
  return { engine, ffmpeg };
}

export async function inspectTool(
  command: string,
  arguments_: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolVersion> {
  try {
    const result = await run(command, arguments_, 5000, env);
    const firstLine = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? null;
    return {
      available: result.code === 0,
      command,
      version: firstLine,
      detail: result.code === 0 ? null : `Exited with status ${result.code}.`,
    };
  } catch (error) {
    return { available: false, command, version: null, detail: toolError(error) };
  }
}

interface CommandResult { code: number; stdout: string; stderr: string }

function run(
  command: string,
  arguments_: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`Terminated by ${signal}.`));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function toolError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    return "Command was not found on PATH.";
  }
  return error instanceof Error ? error.message : String(error);
}
