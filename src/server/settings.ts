import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export type UpdateChannel = "stable" | "latest";
export type CanvasChoice = "auto" | "portrait" | "feed" | "square" | "landscape";
export type AiProvider = "none" | "openai" | "anthropic";
export type AiProviderId = Exclude<AiProvider, "none">;
export type AiReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export const AI_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;

export const BUILTIN_AI_MODELS: Record<AiProviderId, readonly string[]> = {
  openai: [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6",
    "gpt-5",
    "gpt-4.1",
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
  ],
  anthropic: [
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-fable-5",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-5-haiku-latest",
  ],
};

export const DEFAULT_AI_MODELS: Record<AiProviderId, string> = {
  openai: "gpt-5.6-sol",
  anthropic: "claude-sonnet-5",
};

export interface WorkbenchSettings {
  enginePath: string;
  /** Extra MANIC_* environment variables passed to every Manic process. */
  engineEnv: Record<string, string>;
  updateChannel: UpdateChannel;
  updateChecks: boolean;
  preview: { fps: number; scale: number; canvas: CanvasChoice; cpuShaders: boolean };
  ai: {
    provider: AiProvider;
    model: string;
    reasoning: AiReasoningEffort;
    customModels: Record<AiProviderId, string[]>;
  };
}

export const defaultSettings: WorkbenchSettings = {
  enginePath: "",
  engineEnv: {},
  updateChannel: "stable",
  updateChecks: true,
  preview: { fps: 60, scale: 1, canvas: "auto", cpuShaders: false },
  ai: {
    provider: "none",
    model: DEFAULT_AI_MODELS.openai,
    reasoning: "none",
    customModels: { openai: [], anthropic: [] },
  },
};

export interface SettingsStore {
  path: string;
  load(): Promise<WorkbenchSettings>;
  save(input: unknown): Promise<WorkbenchSettings>;
}

export function userSettingsPath(environment = process.env): string {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Manic Workbench", "settings.json");
  }
  if (platform() === "win32") {
    return join(environment.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Manic Workbench", "settings.json");
  }
  return join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "manic-workbench", "settings.json");
}

export function createSettingsStore(path = process.env.MANIC_WORKBENCH_SETTINGS || userSettingsPath()): SettingsStore {
  return {
    path,
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return validateSettings(parsed);
      } catch (error) {
        if (isMissingFile(error)) return structuredClone(defaultSettings);
        throw new Error(`Unable to read Workbench settings: ${errorMessage(error)}`);
      }
    },
    async save(input) {
      const settings = validateSettings(input);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
      await chmod(path, 0o600);
      return settings;
    },
  };
}

export function validateSettings(input: unknown): WorkbenchSettings {
  if (!isRecord(input)) throw new Error("Settings must be an object.");
  const preview = isRecord(input.preview) ? input.preview : {};
  const ai = isRecord(input.ai) ? input.ai : {};
  const provider = enumValue(ai.provider, ["none", "openai", "anthropic"] as const, "ai.provider", "none");
  const customModels = validateCustomModels(ai.customModels);
  const model = stringValue(ai.model, "ai.model", defaultModelFor(provider));

  return {
    enginePath: stringValue(input.enginePath, "enginePath", ""),
    engineEnv: validateEngineEnv(input.engineEnv),
    updateChannel: enumValue(input.updateChannel, ["stable", "latest"] as const, "updateChannel", "stable"),
    updateChecks: booleanValue(input.updateChecks, "updateChecks", true),
    preview: {
      fps: numberValue(preview.fps, "preview.fps", 60, 1, 240),
      scale: numberValue(preview.scale, "preview.scale", 1, 0.1, 8),
      canvas: enumValue(
        preview.canvas,
        ["auto", "portrait", "feed", "square", "landscape"] as const,
        "preview.canvas",
        "auto",
      ),
      cpuShaders: booleanValue(preview.cpuShaders, "preview.cpuShaders", false),
    },
    ai: {
      provider,
      model: normalizeModelChoice(model, provider, customModels),
      reasoning: enumValue(ai.reasoning, AI_REASONING_EFFORTS, "ai.reasoning", "none"),
      customModels,
    },
  };
}

function validateEngineEnv(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (!isRecord(input)) throw new Error("engineEnv must be an object of MANIC_* string values.");
  const entries = Object.entries(input);
  if (entries.length > 64) throw new Error("engineEnv may contain at most 64 entries.");
  const env: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim().toUpperCase();
    if (!/^MANIC_[A-Z0-9_]+$/u.test(key)) {
      throw new Error("engineEnv keys must look like MANIC_ASSETS_DIR.");
    }
    if (typeof rawValue !== "string") throw new Error(`engineEnv.${key} must be a string.`);
    if (rawValue.length > 4096) throw new Error(`engineEnv.${key} is too long.`);
    if (!rawValue.trim()) continue;
    env[key] = rawValue;
  }
  return env;
}

export function modelsForProvider(provider: AiProviderId, customModels: Record<AiProviderId, string[]>): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const model of [...BUILTIN_AI_MODELS[provider], ...customModels[provider]]) {
    const normalized = model.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    models.push(normalized);
  }
  return models;
}

function validateCustomModels(input: unknown): Record<AiProviderId, string[]> {
  const record = isRecord(input) ? input : {};
  return {
    openai: modelList(record.openai, "ai.customModels.openai", "openai"),
    anthropic: modelList(record.anthropic, "ai.customModels.anthropic", "anthropic"),
  };
}

function modelList(value: unknown, name: string, provider: AiProviderId): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of model ids.`);
  const builtins = new Set(BUILTIN_AI_MODELS[provider]);
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${name} must be an array of model ids.`);
    const model = item.trim();
    if (!model || builtins.has(model)) continue;
    if (model.length > 128) throw new Error(`${name} contains a model id that is too long.`);
    if (!/^[A-Za-z0-9._:/-]+$/u.test(model)) throw new Error(`${name} contains an invalid model id.`);
    if (seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  if (models.length > 64) throw new Error(`${name} may contain at most 64 custom models.`);
  return models;
}

function defaultModelFor(provider: AiProvider): string {
  if (provider === "anthropic") return DEFAULT_AI_MODELS.anthropic;
  return DEFAULT_AI_MODELS.openai;
}

function normalizeModelChoice(
  model: string,
  provider: AiProvider,
  customModels: Record<AiProviderId, string[]>,
): string {
  const trimmed = model.trim();
  if (!trimmed) return defaultModelFor(provider);
  if (provider === "none") return trimmed;
  const available = modelsForProvider(provider, customModels);
  if (available.includes(trimmed)) return trimmed;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  if (value.length > 4096) throw new Error(`${name} is too long.`);
  return value;
}

function booleanValue(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
  return value;
}

function numberValue(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  name: string,
  fallback: T[number],
): T[number] {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${name} must be one of: ${choices.join(", ")}.`);
  }
  return value as T[number];
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
