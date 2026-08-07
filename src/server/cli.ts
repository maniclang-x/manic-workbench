#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import open from "open";
import { createApp } from "./app.js";
import { collectDiagnostics } from "./diagnostics.js";
import { pickFolder } from "./folderPicker.js";
import { createSettingsStore } from "./settings.js";
import { resolveWorkspace } from "./workspace.js";

const parsed = parseArguments(process.argv.slice(2));
const version = await packageVersion();

if (parsed.help) {
  console.log(`Manic Workbench ${version}\n\nUsage:\n  manic-workbench [project-directory]\n\nOptions:\n  --manic PATH   use a specific Manic executable\n  --port PORT    use a specific loopback port\n  --no-open      do not open a browser automatically\n  --version      print the Workbench version\n  --help         show this help\n\nWith no project directory, Workbench opens ./examples when present, otherwise the current directory.`);
  process.exit(0);
}
if (parsed.version) {
  console.log(`manic-workbench ${version}`);
  process.exit(0);
}

const workspace = await resolveWorkspace(parsed.workspace);
const settingsStore = createSettingsStore();
const token = randomBytes(32).toString("base64url");
const host = "127.0.0.1";
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/client");

const started = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolveStarted) => {
  let server: ReturnType<typeof serve>;
  const app = createApp({
    token,
    workspace,
    clientRoot,
    version,
    settingsStore,
    diagnostics: async (settings) => collectDiagnostics({
      ...settings,
      enginePath: parsed.manicPath || settings.enginePath,
    }),
    pickWorkspace: pickFolder,
    engineOverride: parsed.manicPath,
  });
  server = serve({ fetch: app.fetch, hostname: host, port: parsed.port }, (info) => {
    resolveStarted({ server, port: info.port });
  });
});

const origin = `http://${host}:${started.port}`;
const url = `${origin}/?session=${encodeURIComponent(token)}`;
console.log(`Manic Workbench ${version}`);
console.log(`Workspace: ${workspace}`);
console.log(`Local URL: ${url}`);

if (!parsed.noOpen) {
  await open(url, { wait: false });
}

const shutdown = () => {
  started.server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

interface ParsedArguments {
  workspace: string;
  manicPath: string;
  port: number;
  noOpen: boolean;
  help: boolean;
  version: boolean;
}

function parseArguments(arguments_: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    workspace: "", manicPath: "", port: 0, noOpen: false, help: false, version: false,
  };
  let workspaceSeen = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--no-open") parsed.noOpen = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--version" || argument === "-V") parsed.version = true;
    else if (argument === "--manic") parsed.manicPath = requiredValue(arguments_, ++index, "--manic");
    else if (argument === "--port") {
      const value = Number(requiredValue(arguments_, ++index, "--port"));
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("--port must be between 0 and 65535.");
      parsed.port = value;
    } else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (workspaceSeen) throw new Error("Pass only one project directory.");
    else {
      parsed.workspace = argument;
      workspaceSeen = true;
    }
  }
  if (!parsed.workspace) parsed.workspace = defaultWorkspace();
  return parsed;
}

/** Prefer the bundled examples catalogue when launched with no project path. */
function defaultWorkspace(): string {
  const candidates = [
    resolve(process.cwd(), "examples"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../examples"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  return process.cwd();
}

function requiredValue(arguments_: string[], index: number, option: string): string {
  const value = arguments_[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
  return value;
}

async function packageVersion(): Promise<string> {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}
