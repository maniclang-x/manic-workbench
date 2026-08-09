/**
 * Versioned Manic Agent protocol.
 *
 * Every type in this module is pure, JSON-serializable data with no Node,
 * filesystem, provider, or UI dependency, so the same contract can later be
 * reused by Manic Cloud adapters. Behavior lives in manicAgent.ts and
 * agentThreads.ts; this file is the wire vocabulary.
 */

export const AGENT_PROTOCOL_VERSION = 1;

export type AgentIntent = "create" | "refine" | "diagnose";
export type AgentState = "fetching_context" | "generating" | "checking" | "repairing" | "ready" | "failed" | "cancelled";
export type AgentRunStatus = "running" | "ready" | "failed" | "cancelled";

export interface AgentImage {
  name: string;
  dataUrl: string;
}

export interface AgentRunInput {
  message: string;
  intent: AgentIntent;
  path: string;
  newPath: string;
  images: AgentImage[];
  /** Present when this run is one turn in an authorship thread. */
  threadId?: string;
  /** Per-run provider override chosen in the chat composer. */
  provider?: "openai" | "anthropic";
  /** Per-run model override chosen in the chat composer. */
  model?: string;
  /** Per-run reasoning-effort override chosen in the chat composer. */
  reasoning?: "none" | "low" | "medium" | "high" | "xhigh";
  /** Per-run OpenAI-compatible endpoint override; "" = official api.openai.com. */
  baseUrl?: string;
}

export interface AgentEvent {
  state: AgentState;
  message: string;
  at: number;
}

export interface AgentProposal {
  operation: "create" | "replace";
  path: string;
  content: string;
  basedOnRevision: string | null;
}

export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface Candidate {
  operation: "create" | "replace";
  path: string;
  message: string;
  content: string;
}

export interface ModelRequest {
  systemPrompt: string;
  userMessage: string;
  intent: AgentIntent;
  targetPath: string;
  activeDocument: { path: string; content: string; revision: string } | null;
  /** Compressed authorship-thread history; empty for single-shot runs. */
  conversation: string;
  images: AgentImage[];
  diagnostics: string;
  previousCandidate: Candidate | null;
}

export interface ModelResult {
  candidate: Candidate;
  usage: AgentUsage;
}

export interface ModelProvider {
  generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult>;
}

export const CANDIDATE_SCHEMA = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["create", "replace"] },
    path: { type: "string" },
    message: { type: "string" },
    content: { type: "string" },
  },
  required: ["operation", "path", "message", "content"],
  additionalProperties: false,
} as const;

/**
 * Authorship threads: a thread binds a conversation to exactly one target
 * `.manic` document. Chat steers intent; the on-disk revision stays the
 * ground truth for every turn.
 */
export type ThreadTarget =
  | { kind: "file"; path: string }
  | { kind: "draft"; draftName: string };

export type ThreadTurnStatus = Exclude<AgentRunStatus, "running">;

export interface ThreadTurn {
  runId: string;
  userMessage: string;
  /** The agent's own one-paragraph description of what the turn produced. */
  proposalSummary: string;
  status: ThreadTurnStatus;
  /** Revision hash saved to disk when the turn's proposal was applied; null otherwise. */
  appliedRevision: string | null;
  at: number;
}

export interface AgentThread {
  protocolVersion: number;
  threadId: string;
  target: ThreadTarget;
  turns: ThreadTurn[];
  /** Revision hash of the last proposal this thread applied to disk. */
  lastAppliedRevision: string | null;
  createdAt: number;
  updatedAt: number;
}
