import type { ManicPrompt } from "./promptStore.js";
import type { WorkbenchSettings } from "./settings.js";
import {
  runManicAgent,
  type AgentEvent,
  type AgentProposal,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunStatus,
  type EngineChecker,
  type ModelProvider,
} from "./manicAgent.js";
import type { EngineCheckResult } from "./engineCheck.js";

export interface AgentRunView {
  id: string;
  status: AgentRunStatus;
  message: string;
  proposal: AgentProposal | null;
  baseContent: string;
  validation: EngineCheckResult & { attempts: number };
  events: AgentEvent[];
  prompt: Pick<ManicPrompt, "version" | "source" | "fetchedAt"> | null;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  startedAt: number;
  finishedAt: number | null;
}

interface AgentRunRecord extends AgentRunView {
  controller: AbortController;
}

export class AgentRunManager {
  private readonly runs = new Map<string, AgentRunRecord>();

  start(options: {
    workspace: string;
    settings: WorkbenchSettings;
    engineOverride?: string;
    prompt: ManicPrompt;
    provider: ModelProvider;
    input: AgentRunInput;
    conversation?: string;
    check?: EngineChecker;
    autofix?: (content: string, signal?: AbortSignal) => Promise<{ code: string; fixed: number } | null>;
    maxRepairAttempts?: number;
    /** Awaited before the run becomes observable as finished. */
    onFinished?: (result: AgentRunResult) => void | Promise<void>;
  }): AgentRunView {
    if ([...this.runs.values()].some((run) => run.status === "running")) {
      throw new Error("Finish or cancel the current AI run before starting another one.");
    }

    const controller = new AbortController();
    const placeholderId = `agent_pending_${Date.now()}`;
    const record: AgentRunRecord = {
      id: placeholderId,
      status: "running",
      message: "Starting Manic AI…",
      proposal: null,
      baseContent: "",
      validation: { ok: false, exitCode: null, output: "The run has not finished checking yet.", attempts: 0 },
      events: [],
      prompt: {
        version: options.prompt.version,
        source: options.prompt.source,
        fetchedAt: options.prompt.fetchedAt,
      },
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      startedAt: Date.now(),
      finishedAt: null,
      controller,
    };

    const onEvent = (event: AgentEvent) => {
      record.events = [...record.events, event];
      if (event.state === "fetching_context" || event.state === "generating" || event.state === "checking" || event.state === "repairing") {
        record.message = event.message;
      }
    };

    // Kick off asynchronously; HTTP returns the live view immediately.
    void runManicAgent({
      workspace: options.workspace,
      settings: options.settings,
      engineOverride: options.engineOverride,
      prompt: options.prompt,
      provider: options.provider,
      input: options.input,
      conversation: options.conversation,
      signal: controller.signal,
      check: options.check,
      autofix: options.autofix,
      maxRepairAttempts: options.maxRepairAttempts,
      onEvent,
    }).then(async (result) => {
      await notifyFinished(options.onFinished, result);
      this.applyResult(record, result);
    }).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "The Manic AI run failed.";
      const failure: AgentRunResult = {
        id: record.id,
        status: "failed",
        message,
        proposal: null,
        baseContent: "",
        validation: { ok: false, exitCode: null, output: message, attempts: 0 },
        events: [...record.events, { state: "failed", message, at: Date.now() }],
        prompt: {
          version: options.prompt.version,
          source: options.prompt.source,
          fetchedAt: options.prompt.fetchedAt,
        },
        usage: record.usage,
      };
      await notifyFinished(options.onFinished, failure);
      record.status = "failed";
      record.message = message;
      record.finishedAt = Date.now();
      record.events = failure.events;
    });

    // Replace placeholder id once the agent assigns a stable id via first event path.
    // Until then keep the temporary id for polling; swap when result arrives.
    this.runs.set(record.id, record);

    // Bridge: watch for id from result through a microtask after start — also expose alias.
    // We patch id when applyResult runs. For immediate polls, temporary id works.
    return publicRun(record);
  }

  get(id: string): AgentRunView | null {
    const run = this.runs.get(id) ?? [...this.runs.values()].find((item) => item.id === id) ?? null;
    return run ? publicRun(run) : null;
  }

  cancel(id: string): AgentRunView {
    const run = this.runs.get(id) ?? [...this.runs.values()].find((item) => item.id === id);
    if (!run) throw new Error("That AI run was not found.");
    if (run.status === "running") {
      run.message = "Cancelling…";
      run.controller.abort();
    }
    return publicRun(run);
  }

  private applyResult(record: AgentRunRecord, result: AgentRunResult): void {
    const previousId = record.id;
    record.id = result.id;
    record.status = result.status;
    record.message = result.message;
    record.proposal = result.proposal;
    record.baseContent = result.baseContent;
    record.validation = result.validation;
    record.events = result.events;
    record.prompt = result.prompt;
    record.usage = result.usage;
    record.finishedAt = Date.now();
    if (previousId !== result.id) {
      this.runs.delete(previousId);
      this.runs.set(result.id, record);
      // Keep temporary id aliased until clients finish polling.
      this.runs.set(previousId, record);
    }
  }
}

async function notifyFinished(
  onFinished: ((result: AgentRunResult) => void | Promise<void>) | undefined,
  result: AgentRunResult,
): Promise<void> {
  try {
    await onFinished?.(result);
  } catch (error) {
    console.error("Agent run completion hook failed:", error);
  }
}

function publicRun(run: AgentRunRecord): AgentRunView {
  return {
    id: run.id,
    status: run.status,
    message: run.message,
    proposal: run.proposal,
    baseContent: run.baseContent,
    validation: run.validation,
    events: run.events,
    prompt: run.prompt,
    usage: run.usage,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}
