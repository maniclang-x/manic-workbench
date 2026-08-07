import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export async function discoverInstalledManic(): Promise<string | null> {
  for (const candidate of candidateManicPaths()) {
    if (await isExecutable(candidate)) return candidate;
  }
  return whichCommand("manic");
}

export function candidateManicPaths(): string[] {
  const home = homedir();
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      join(local, "Manic", "bin", "manic.exe"),
      join(local, "Manic", "bin", "manic"),
    ];
  }
  return [
    join(home, ".local", "bin", "manic"),
    "/opt/homebrew/bin/manic",
    "/usr/local/bin/manic",
  ];
}

export function defaultBinaryPath(): string {
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "Manic", "bin", "manic.exe");
  }
  return join(homedir(), ".local", "bin", "manic");
}

async function whichCommand(command: string): Promise<string | null> {
  try {
    const result = await runCapture(
      platform() === "win32" ? "where.exe" : "/usr/bin/which",
      [command],
      5_000,
    );
    const first = result.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

function runCapture(command: string, arguments_: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("which timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error("not found"));
    });
  });
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
