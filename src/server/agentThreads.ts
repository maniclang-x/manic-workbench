import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  AGENT_PROTOCOL_VERSION,
  type AgentThread,
  type ThreadTarget,
  type ThreadTurn,
} from "./agentProtocol.js";

/**
 * Authorship-thread persistence. A thread is one JSON sidecar file under the
 * workspace, following the render-job pattern: no database, atomic writes,
 * and the file is a record — the on-disk `.manic` document stays the ground
 * truth for every turn.
 *
 * The directory name must keep the `.manic-workbench-` prefix so the
 * workspace file walk ignores it.
 */
const THREADS_DIRECTORY = ".manic-workbench-threads";
const THREAD_ID_PATTERN = /^thread_[a-f0-9]{32}$/u;

export class ThreadNotFoundError extends Error {}

export async function createThread(workspace: string, target: ThreadTarget): Promise<AgentThread> {
  validateTarget(target);
  const now = Date.now();
  const thread: AgentThread = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    threadId: `thread_${randomUUID().replaceAll("-", "")}`,
    target,
    turns: [],
    lastAppliedRevision: null,
    createdAt: now,
    updatedAt: now,
  };
  await persist(workspace, thread);
  return thread;
}

export async function getThread(workspace: string, threadId: string): Promise<AgentThread> {
  const raw = await readFile(threadFile(workspace, threadId), "utf8").catch(() => null);
  if (raw === null) throw new ThreadNotFoundError("That authorship thread was not found.");
  const thread = parseThread(raw);
  if (!thread || thread.threadId !== threadId) throw new ThreadNotFoundError("That authorship thread is not readable.");
  return thread;
}

export async function listThreads(workspace: string): Promise<AgentThread[]> {
  const entries = await readdir(join(workspace, THREADS_DIRECTORY)).catch(() => [] as string[]);
  const threads: AgentThread[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || !THREAD_ID_PATTERN.test(entry.slice(0, -".json".length))) continue;
    const raw = await readFile(join(workspace, THREADS_DIRECTORY, entry), "utf8").catch(() => null);
    const thread = raw === null ? null : parseThread(raw);
    if (thread) threads.push(thread);
  }
  return threads.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function removeThread(workspace: string, threadId: string): Promise<void> {
  await getThread(workspace, threadId);
  await unlink(threadFile(workspace, threadId));
}

export async function appendTurn(workspace: string, threadId: string, turn: ThreadTurn): Promise<AgentThread> {
  const thread = await getThread(workspace, threadId);
  thread.turns.push(validateTurn(turn));
  thread.updatedAt = Date.now();
  await persist(workspace, thread);
  return thread;
}

/**
 * Records that a turn's proposal was saved to disk. From this point the
 * written revision is the thread's baseline; a draft-bound thread rebinds to
 * the created file so the next turn refines it instead of creating again.
 */
export async function recordApply(
  workspace: string,
  threadId: string,
  runId: string,
  path: string,
  revision: string,
): Promise<AgentThread> {
  const thread = await getThread(workspace, threadId);
  const turn = thread.turns.find((item) => item.runId === runId);
  if (!turn) throw new Error("That run is not a turn in this thread.");
  if (turn.status !== "ready") throw new Error("Only a Manic-validated turn can be applied.");
  turn.appliedRevision = revision;
  thread.lastAppliedRevision = revision;
  thread.target = { kind: "file", path };
  thread.updatedAt = Date.now();
  await persist(workspace, thread);
  return thread;
}

const RECENT_TURNS = 3;
const RECENT_MESSAGE_LIMIT = 2_000;
const SUMMARY_LIMIT = 1_000;
const OLDER_LINE_LIMIT = 200;
const CONVERSATION_LIMIT = 12_000;

/**
 * Builds the compressed steering context for the next turn. Pure function so
 * the policy is directly testable. `currentRevision` is the revision of the
 * target document as it exists on disk right now (null for unborn drafts).
 */
export function buildConversation(thread: AgentThread, currentRevision: string | null): string {
  const sections: string[] = [];
  if (
    thread.lastAppliedRevision !== null
    && currentRevision !== null
    && currentRevision !== thread.lastAppliedRevision
  ) {
    sections.push(
      "Note: the document was edited outside this conversation after the last applied proposal. "
      + "The current document source is authoritative; earlier statements in this conversation may no longer describe it.",
    );
  }
  const older = thread.turns.slice(0, -RECENT_TURNS);
  if (older.length) {
    sections.push([
      "Earlier turns (summarized):",
      ...older.map((turn) => `- [${turn.status}] "${truncate(turn.userMessage, OLDER_LINE_LIMIT)}" → ${truncate(turn.proposalSummary, OLDER_LINE_LIMIT)}`),
    ].join("\n"));
  }
  for (const turn of thread.turns.slice(-RECENT_TURNS)) {
    sections.push(`User: ${truncate(turn.userMessage, RECENT_MESSAGE_LIMIT)}\nAgent (${turn.status}${turn.appliedRevision ? ", applied" : ", not applied"}): ${truncate(turn.proposalSummary, SUMMARY_LIMIT)}`);
  }
  return truncate(sections.join("\n\n"), CONVERSATION_LIMIT);
}

function truncate(value: string, limit: number): string {
  const flat = value.replaceAll(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

async function persist(workspace: string, thread: AgentThread): Promise<void> {
  const directory = join(workspace, THREADS_DIRECTORY);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const file = threadFile(workspace, thread.threadId);
  const temporary = join(directory, `.${thread.threadId}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(thread, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function threadFile(workspace: string, threadId: string): string {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new ThreadNotFoundError("That authorship thread was not found.");
  return join(workspace, THREADS_DIRECTORY, `${threadId}.json`);
}

function validateTarget(target: ThreadTarget): void {
  if (target.kind === "file") validateRelativeManicPath(target.path);
  else if (target.kind === "draft") validateRelativeManicPath(target.draftName);
  else throw new Error("A thread target must be an existing file or a named draft.");
}

function validateRelativeManicPath(path: string): void {
  if (
    typeof path !== "string"
    || !path
    || path.includes("\0")
    || path.startsWith("/")
    || path.replaceAll("\\", "/").split("/").some((part) => !part || part === "." || part === "..")
    || extname(path).toLowerCase() !== ".manic"
  ) {
    throw new Error("Thread targets must be relative .manic files inside the selected project.");
  }
}

function validateTurn(turn: ThreadTurn): ThreadTurn {
  if (!turn || typeof turn.runId !== "string" || !turn.runId) throw new Error("A thread turn requires its run id.");
  if (typeof turn.userMessage !== "string" || typeof turn.proposalSummary !== "string") throw new Error("A thread turn requires the user message and proposal summary.");
  if (!(["ready", "failed", "cancelled"] as string[]).includes(turn.status)) throw new Error("A thread turn requires a finished run status.");
  return {
    runId: turn.runId,
    userMessage: turn.userMessage,
    proposalSummary: turn.proposalSummary,
    status: turn.status,
    appliedRevision: turn.appliedRevision ?? null,
    at: typeof turn.at === "number" ? turn.at : Date.now(),
  };
}

function parseThread(raw: string): AgentThread | null {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return null; }
  if (!value || typeof value !== "object") return null;
  const thread = value as AgentThread;
  if (typeof thread.threadId !== "string" || !THREAD_ID_PATTERN.test(thread.threadId)) return null;
  if (typeof thread.protocolVersion !== "number" || thread.protocolVersion > AGENT_PROTOCOL_VERSION) return null;
  if (!thread.target || typeof thread.target !== "object" || !Array.isArray(thread.turns)) return null;
  try { validateTarget(thread.target); }
  catch { return null; }
  return {
    protocolVersion: thread.protocolVersion,
    threadId: thread.threadId,
    target: thread.target,
    turns: thread.turns.map((turn) => validateTurn(turn)),
    lastAppliedRevision: typeof thread.lastAppliedRevision === "string" ? thread.lastAppliedRevision : null,
    createdAt: typeof thread.createdAt === "number" ? thread.createdAt : Date.now(),
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : Date.now(),
  };
}
