export interface ToolVersion {
  available: boolean;
  command: string;
  version: string | null;
  detail: string | null;
}

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

export const KNOWN_AI_SECRET_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

export interface WorkbenchSettings {
  enginePath: string;
  engineEnv: Record<string, string>;
  updateChannel: "stable" | "latest";
  updateChecks: boolean;
  preview: {
    fps: number;
    scale: number;
    canvas: "auto" | "portrait" | "feed" | "square" | "landscape";
    cpuShaders: boolean;
  };
  ai: {
    provider: AiProvider;
    model: string;
    reasoning: AiReasoningEffort;
    /** OpenAI-compatible endpoint (e.g. http://localhost:11434/v1 for Ollama). Empty = api.openai.com. */
    baseUrl: string;
    customModels: Record<AiProviderId, string[]>;
  };
}

/** Suggest …/share/manic/assets from …/bin/manic. */
export function suggestAssetsDirFromEnginePath(enginePath: string): string | null {
  const trimmed = enginePath.trim().replace(/\\/gu, "/");
  if (!trimmed) return null;
  const match = /^(.*)\/bin\/manic(?:\.exe)?$/iu.exec(trimmed);
  if (!match?.[1]) return null;
  return `${match[1]}/share/manic/assets`;
}

export interface AiSecretEntryStatus {
  key: string;
  configured: boolean;
  source: "environment" | "session" | "none";
}

export interface AiSecretStatus {
  entries: AiSecretEntryStatus[];
}

export interface Bootstrap {
  workbench: { version: string };
  workspace: string;
  settings: WorkbenchSettings;
  settingsPath: string;
  diagnostics: { engine: ToolVersion; ffmpeg: ToolVersion };
  ai: AiSecretStatus;
}

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
  channel: "stable" | "latest";
  docsUrl: string;
  releasesUrl: string;
  manualCommand: string;
  defaultBinaryHint: string;
  discoveredBinary: string | null;
}

export interface EngineInstallResult {
  ok: boolean;
  method: EngineInstallMethod;
  channel: "stable" | "latest";
  log: string;
  binaryPath: string | null;
  suggestedEnginePath: string | null;
}

export interface AgentImage { name: string; dataUrl: string; }
export interface AgentEvent {
  state: "fetching_context" | "generating" | "checking" | "repairing" | "ready" | "failed" | "cancelled";
  message: string;
  at: number;
}
export interface AgentProposal { operation: "create" | "replace"; path: string; content: string; basedOnRevision: string | null; }
export interface AgentRunView {
  id: string;
  status: "running" | "ready" | "failed" | "cancelled";
  message: string;
  proposal: AgentProposal | null;
  baseContent: string;
  validation: EngineCheckResult & { attempts: number };
  events: AgentEvent[];
  prompt: { version: string; source: "remote" | "cache" | "bundled"; fetchedAt: number } | null;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  startedAt: number;
  finishedAt: number | null;
}

/** @deprecated Prefer AgentRunView for async runs. */
export type AgentRunResult = AgentRunView;

export type ThreadTarget =
  | { kind: "file"; path: string }
  | { kind: "draft"; draftName: string };

export interface ThreadTurn {
  runId: string;
  userMessage: string;
  proposalSummary: string;
  status: "ready" | "failed" | "cancelled";
  appliedRevision: string | null;
  at: number;
}

export interface AgentThreadView {
  protocolVersion: number;
  threadId: string;
  target: ThreadTarget;
  turns: ThreadTurn[];
  lastAppliedRevision: string | null;
  createdAt: number;
  updatedAt: number;
}

export function threadTargetPath(target: ThreadTarget): string {
  return target.kind === "file" ? target.path : target.draftName;
}

export interface WorkspaceFileSummary {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  version: string;
}

export interface WorkspaceFile extends WorkspaceFileSummary {
  content: string;
}

export interface EngineCheckResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface PreviewResult {
  started: boolean;
  path: string;
  check: EngineCheckResult;
}

export type RenderFormat = "mp4" | "gif" | "png";
export interface RenderJob {
  id: string;
  file: string;
  format: RenderFormat;
  options: {
    format: RenderFormat;
    fps: number;
    scale: number;
    canvas: WorkbenchSettings["preview"]["canvas"];
    cpuShaders: boolean;
    branded: boolean;
  };
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  finishedAt: number | null;
  log: string;
  outputName: string | null;
  frameCount: number | null;
  progress: {
    phase: "preparing" | "rendering" | "encoding" | "complete" | "failed" | "cancelled";
    percent: number | null;
    framesRendered: number | null;
    totalFrames: number | null;
    elapsedMs: number;
  };
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

export function secretEntry(secrets: AiSecretStatus, key: string): AiSecretEntryStatus {
  return secrets.entries.find((entry) => entry.key === key) ?? { key, configured: false, source: "none" };
}

export function providerSecretKey(provider: AiProvider): string | null {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  return null;
}

export function establishSession(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("session");
  if (fromUrl) {
    sessionStorage.setItem("manic-workbench-session", fromUrl);
    url.searchParams.delete("session");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return fromUrl ?? sessionStorage.getItem("manic-workbench-session") ?? "";
}

export async function apiRequest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Manic-Session": token,
      ...init?.headers,
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Workbench request failed (${response.status}).`);
  return body;
}
