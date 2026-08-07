import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { UpdateChannel } from "./settings.js";
import { defaultBinaryPath, discoverInstalledManic } from "./enginePaths.js";

export type EngineInstallMethod = "script" | "brew";

export interface EngineInstallMethodInfo {
  id: EngineInstallMethod;
  label: string;
  description: string;
  available: boolean;
  detail: string | null;
}

export interface EngineInstallPlan {
  platform: "darwin" | "linux" | "win32" | "unsupported";
  arch: string;
  methods: EngineInstallMethodInfo[];
  channel: UpdateChannel;
  docsUrl: string;
  releasesUrl: string;
  manualCommand: string;
  defaultBinaryHint: string;
  discoveredBinary: string | null;
}

export interface EngineInstallResult {
  ok: boolean;
  method: EngineInstallMethod;
  channel: UpdateChannel;
  log: string;
  binaryPath: string | null;
  suggestedEnginePath: string | null;
}

const INSTALL_SH = "https://raw.githubusercontent.com/maniclang-x/manic/main/install.sh";
const INSTALL_PS1 = "https://raw.githubusercontent.com/maniclang-x/manic/main/install.ps1";
const DOCS_URL = "https://github.com/maniclang-x/manic/blob/main/INSTALL.md";
const RELEASES_URL = "https://github.com/maniclang-x/manic/releases";

let installInFlight: Promise<EngineInstallResult> | null = null;

export async function getEngineInstallPlan(channel: UpdateChannel): Promise<EngineInstallPlan> {
  const host = hostPlatform();
  const arch = process.arch;
  const brew = host === "darwin" ? await commandExists("brew") : false;
  const methods: EngineInstallMethodInfo[] = [];

  if (host === "darwin" || host === "linux") {
    methods.push({
      id: "script",
      label: "Official installer",
      description: `Download and run install.sh for the ${channel} channel into ~/.local.`,
      available: true,
      detail: null,
    });
  }
  if (host === "win32") {
    methods.push({
      id: "script",
      label: "Official installer",
      description: `Download and run install.ps1 for the ${channel} channel into %LOCALAPPDATA%\\Manic.`,
      available: true,
      detail: null,
    });
  }
  if (host === "darwin") {
    methods.push({
      id: "brew",
      label: "Homebrew cask",
      description: "Install maniclang-x/tap/manic (Apple Silicon; includes ffmpeg).",
      available: brew,
      detail: brew ? null : "Homebrew was not found on PATH.",
    });
  }
  if (host === "unsupported") {
    methods.push({
      id: "script",
      label: "Official installer",
      description: "This platform is not supported by the Workbench installer yet.",
      available: false,
      detail: `Unsupported platform: ${platform()}`,
    });
  }

  const discoveredBinary = await discoverInstalledManic();
  return {
    platform: host,
    arch,
    methods,
    channel,
    docsUrl: DOCS_URL,
    releasesUrl: RELEASES_URL,
    manualCommand: manualCommand(host, channel),
    defaultBinaryHint: defaultBinaryPath(),
    discoveredBinary,
  };
}

export async function installManicEngine(options: {
  method: EngineInstallMethod;
  channel: UpdateChannel;
  currentEnginePath?: string;
}): Promise<EngineInstallResult> {
  if (installInFlight) throw new Error("A Manic install is already running.");
  installInFlight = runInstall(options).finally(() => { installInFlight = null; });
  return installInFlight;
}

async function runInstall(options: {
  method: EngineInstallMethod;
  channel: UpdateChannel;
  currentEnginePath?: string;
}): Promise<EngineInstallResult> {
  const channel = options.channel === "stable" ? "stable" : "latest";
  let log = "";
  try {
    if (options.method === "brew") {
      log = await runBrewInstall();
    } else if (options.method === "script") {
      log = await runOfficialScript(channel);
    } else {
      throw new Error("Choose a supported Manic install method.");
    }

    const binaryPath = await discoverInstalledManic();
    const ok = Boolean(binaryPath);
    return {
      ok,
      method: options.method,
      channel,
      log: appendHint(log, binaryPath, ok),
      binaryPath,
      suggestedEnginePath: !options.currentEnginePath?.trim() && binaryPath ? binaryPath : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const binaryPath = await discoverInstalledManic();
    return {
      ok: false,
      method: options.method,
      channel,
      log: `${log}${log ? "\n" : ""}${message}`.trim(),
      binaryPath,
      suggestedEnginePath: null,
    };
  }
}

async function runOfficialScript(channel: UpdateChannel): Promise<string> {
  const host = hostPlatform();
  if (host === "unsupported") throw new Error("This operating system is not supported by the Manic installer yet.");

  const directory = await mkdtemp(join(tmpdir(), "manic-workbench-install-"));
  try {
    if (host === "win32") {
      const scriptPath = join(directory, "install.ps1");
      await downloadToFile(INSTALL_PS1, scriptPath);
      return await runCommand(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { MANIC_CHANNEL: channel },
        10 * 60_000,
      );
    }

    const scriptPath = join(directory, "install.sh");
    await downloadToFile(INSTALL_SH, scriptPath);
    await chmod(scriptPath, 0o700);
    const prefix = join(homedir(), ".local");
    await mkdir(join(prefix, "bin"), { recursive: true, mode: 0o755 });
    return await runCommand(
      "/bin/sh",
      [scriptPath],
      { MANIC_CHANNEL: channel, MANIC_INSTALL_DIR: prefix },
      10 * 60_000,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runBrewInstall(): Promise<string> {
  if (hostPlatform() !== "darwin") throw new Error("Homebrew installation is only available on macOS.");
  if (!(await commandExists("brew"))) throw new Error("Homebrew was not found. Install Homebrew or use the official installer.");
  return runCommand("brew", ["install", "--cask", "maniclang-x/tap/manic"], {}, 15 * 60_000);
}

function manualCommand(host: EngineInstallPlan["platform"], channel: UpdateChannel): string {
  if (host === "win32") {
    return channel === "stable"
      ? `$env:MANIC_CHANNEL='stable'; irm ${INSTALL_PS1} | iex`
      : `irm ${INSTALL_PS1} | iex`;
  }
  if (host === "darwin" || host === "linux") {
    return channel === "stable"
      ? `curl -fsSL ${INSTALL_SH} | MANIC_CHANNEL=stable sh`
      : `curl -fsSL ${INSTALL_SH} | sh`;
  }
  return `See ${DOCS_URL}`;
}

function hostPlatform(): EngineInstallPlan["platform"] {
  const value = platform();
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  return "unsupported";
}

async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download the Manic installer (${response.status}).`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new Error("The Manic installer download returned HTML instead of a script.");
  }
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(destination));
  const text = await readFile(destination, "utf8");
  if (text.length < 40 || text.includes("<!DOCTYPE html>")) {
    throw new Error("The Manic installer script looks invalid.");
  }
  // Touch mtime so local antivirus scanners see a complete file.
  await writeFile(destination, text, { encoding: "utf8" });
}

function runCommand(
  command: string,
  arguments_: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-200_000);
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Manic install timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const log = output.trim() || `(no installer output; exit ${code ?? "unknown"})`;
      if (code === 0) resolve(log);
      else reject(new Error(`${log}\nInstaller exited with status ${code ?? "unknown"}.`));
    });
  });
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await runCommand(
      platform() === "win32" ? "where.exe" : "/usr/bin/which",
      [command],
      {},
      5_000,
    );
    return true;
  } catch {
    return false;
  }
}

function appendHint(log: string, binaryPath: string | null, ok: boolean): string {
  const lines = [log];
  if (binaryPath) lines.push(`Detected Manic at ${binaryPath}.`);
  if (!ok) {
    lines.push("Install finished, but Workbench still cannot run Manic. Open a new terminal or set the executable path explicitly.");
    if (platform() !== "win32") lines.push(`If needed: export PATH="$HOME/.local/bin:$PATH"`);
  }
  return lines.filter(Boolean).join("\n");
}
