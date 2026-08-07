import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AI_REASONING_EFFORTS,
  apiRequest,
  modelsForProvider,
  providerSecretKey,
  secretEntry,
  threadTargetPath,
  type AgentImage,
  type AgentRunView,
  type AgentThreadView,
  type AiProviderId,
  type AiReasoningEffort,
  type AiSecretStatus,
  type WorkspaceFile,
  type WorkspaceFileSummary,
  type WorkbenchSettings,
} from "./api";
import { lineDiff } from "./lineDiff";

export interface EditorOpenRequest { path: string; action: "open" | "render"; nonce: number; }

interface ModelChoice { provider: AiProviderId; model: string; }

const PROVIDERS: AiProviderId[] = ["anthropic", "openai"];

const REASONING_LABELS: Record<AiReasoningEffort, string> = {
  none: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
};

export function AiWorkspace({ token, settings, secrets, onOpen }: {
  token: string;
  settings: WorkbenchSettings;
  secrets: AiSecretStatus;
  onOpen(request: EditorOpenRequest): void;
  onSecretChange?(status: AiSecretStatus): void;
}) {
  const [files, setFiles] = useState<WorkspaceFileSummary[]>([]);
  const [path, setPath] = useState("");
  const [newPath, setNewPath] = useState("ai-story.manic");
  const [intent, setIntent] = useState<"refine" | "diagnose">("refine");
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<AgentImage[]>([]);
  const [thread, setThread] = useState<AgentThreadView | null>(null);
  const [run, setRun] = useState<AgentRunView | null>(null);
  const [notice, setNotice] = useState("");
  const [choice, setChoice] = useState<ModelChoice>(() => initialChoice(settings, secrets));
  const [reasoning, setReasoning] = useState<AiReasoningEffort>(settings.ai.reasoning);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);

  const busy = run?.status === "running";
  const modelGroups = useMemo(() => PROVIDERS.map((provider) => ({
    provider,
    label: provider === "openai" ? "OpenAI" : "Anthropic",
    ready: providerConfigured(secrets, provider),
    models: modelsForProvider(provider, settings.ai.customModels),
  })), [secrets, settings.ai.customModels]);
  const choiceReady = providerConfigured(secrets, choice.provider);
  const latestApplied = !!run && !!thread?.turns.find((turn) => turn.runId === run.id)?.appliedRevision;
  const canSend = choiceReady && !busy && !!message.trim();
  const diffLines = useMemo(
    () => (run?.proposal ? lineDiff(run.baseContent, run.proposal.content) : []),
    [run?.proposal, run?.baseContent],
  );

  useEffect(() => { void refreshFiles(); }, []);

  useEffect(() => {
    if (!run || run.status !== "running") return;
    const timer = window.setInterval(() => void pollRun(run.id), 650);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [thread?.turns.length, run?.status, run?.events.length]);

  async function refreshFiles() {
    try { setFiles((await apiRequest<{ files: WorkspaceFileSummary[] }>(token, "/api/files")).files); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Project files could not be loaded."); }
  }

  async function chooseTarget(value: string) {
    setPath(value);
    setIntent("refine");
    setRun(null);
    setThread(null);
    setNotice("");
    if (!value) return;
    // Resume the most recent thread already bound to this file, if any.
    try {
      const response = await apiRequest<{ threads: AgentThreadView[] }>(token, "/api/ai/threads");
      const existing = response.threads.find((item) => threadTargetPath(item.target) === value);
      if (existing) setThread(existing);
    } catch {
      // Thread history is a convenience; starting fresh is always valid.
    }
  }

  function startNewThread() {
    setThread(null);
    setRun(null);
    setNotice("");
  }

  async function attach(selected: FileList | null) {
    if (!selected) return;
    try {
      const next = await Promise.all([...selected].slice(0, 4).map(async (file) => {
        if (!(["image/png", "image/jpeg", "image/webp", "image/gif"] as string[]).includes(file.type)) throw new Error(`${file.name} is not a supported image.`);
        if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} exceeds 8 MB.`);
        return { name: file.name, dataUrl: await dataUrl(file) };
      }));
      setImages(next);
      setNotice("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Images could not be attached."); }
  }

  async function ensureThread(): Promise<AgentThreadView> {
    if (thread) return thread;
    const body = path ? { path } : { draftName: normalizedPath(newPath) };
    const response = await apiRequest<{ thread: AgentThreadView }>(token, "/api/ai/threads", {
      method: "POST", body: JSON.stringify(body),
    });
    setThread(response.thread);
    return response.thread;
  }

  async function sendTurn() {
    if (!canSend) return;
    setNotice("");
    setRun(null);
    try {
      const active = await ensureThread();
      const response = await apiRequest<{ run: AgentRunView }>(token, "/api/ai/run", {
        method: "POST",
        body: JSON.stringify({
          message, intent, path: "", newPath: "", images,
          threadId: active.threadId,
          provider: choice.provider,
          model: choice.model,
          reasoning,
        }),
      });
      setRun(response.run);
      setMessage("");
      setImages([]);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Manic AI could not start."); }
  }

  async function pollRun(id: string) {
    try {
      const response = await apiRequest<{ run: AgentRunView }>(token, `/api/ai/run/${encodeURIComponent(id)}`);
      setRun(response.run);
      if (response.run.status !== "running") await refreshThread();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "AI run status is unavailable.");
    }
  }

  async function refreshThread() {
    if (!thread) return;
    try {
      const response = await apiRequest<{ thread: AgentThreadView }>(token, `/api/ai/threads/${encodeURIComponent(thread.threadId)}`);
      setThread(response.thread);
    } catch {
      // Keep the local view; the next turn re-reads the thread anyway.
    }
  }

  async function cancelRun() {
    if (!run || run.status !== "running") return;
    try {
      const response = await apiRequest<{ run: AgentRunView }>(token, `/api/ai/run/${encodeURIComponent(run.id)}`, { method: "DELETE" });
      setRun(response.run);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The AI run could not be cancelled.");
    }
  }

  async function applyProposal(): Promise<string> {
    if (!run?.proposal || run.status !== "ready" || !thread) throw new Error("Only a Manic-validated proposal can be applied.");
    if (latestApplied) return run.proposal.path;
    const response = await apiRequest<{ file: WorkspaceFile; thread: AgentThreadView }>(
      token,
      `/api/ai/threads/${encodeURIComponent(thread.threadId)}/apply`,
      { method: "POST", body: JSON.stringify({ runId: run.id }) },
    );
    setThread(response.thread);
    await refreshFiles();
    return response.file.path;
  }

  async function act(action: "open" | "preview" | "render") {
    try {
      const target = await applyProposal();
      if (action === "preview") {
        await apiRequest<{ started: boolean }>(token, "/api/preview", { method: "POST", body: JSON.stringify({ path: target }) });
        setNotice(`Preview opened for ${target}.`);
      } else onOpen({ path: target, action, nonce: Date.now() });
    } catch (error) { setNotice(error instanceof Error ? error.message : "The AI proposal could not be applied."); }
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendTurn();
    }
  }

  const hasConversation = !!thread?.turns.length || !!run;

  return (
    <div className="ai-view">
      <div className="ai-topbar">
        <div className="ai-target-controls">
          <label className="ai-target-field">
            <span>Working on</span>
            <select value={path} onChange={(event) => void chooseTarget(event.target.value)} disabled={busy}>
              <option value="">New Manic file</option>
              {files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
            </select>
          </label>
          {!path && !thread && (
            <label className="ai-target-field">
              <span>Filename</span>
              <input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="story.manic" />
            </label>
          )}
          {path && (
            <label className="ai-target-field">
              <span>Mode</span>
              <select value={intent} onChange={(event) => setIntent(event.target.value as typeof intent)} disabled={busy}>
                <option value="refine">Refine</option>
                <option value="diagnose">Diagnose</option>
              </select>
            </label>
          )}
        </div>
        <div className="ai-topbar-actions">
          {thread && <span className="ai-thread-meta">{thread.turns.length} {thread.turns.length === 1 ? "turn" : "turns"}</span>}
          {thread && !busy && <button className="ai-new-thread" onClick={startNewThread}>New chat</button>}
        </div>
      </div>

      {notice && <div className="notice error">{notice}</div>}

      <div className="ai-stage">
        <div className="ai-transcript" role="log" aria-label="Conversation">
          {!hasConversation && (
            <div className="ai-empty">
              <h2>What should Manic create?</h2>
              <p>Describe an animation in plain language. Every draft is validated with <code>manic check</code> before you apply it — your file on disk is always the source of truth.</p>
            </div>
          )}
          {thread?.turns.map((turn) => (
            <div key={turn.runId} className="ai-turn">
              <div className="ai-bubble user"><p>{turn.userMessage}</p></div>
              <div className={`ai-answer ${turn.status}`}>
                <p>{turn.proposalSummary}</p>
                <span className="ai-turn-state">{turn.status === "ready" ? (turn.appliedRevision ? "Applied" : "Validated") : turn.status === "failed" ? "Needs attention" : "Cancelled"}</span>
              </div>
            </div>
          ))}
          {run && run.status === "running" && (
            <div className="agent-events" aria-live="polite">
              {run.events.map((event, index) => (
                <div key={`${event.at}-${index}`}>
                  <i className={event.state} />
                  <span>{event.message}</span>
                </div>
              ))}
            </div>
          )}
          {run && run.status !== "running" && (
            <div className="ai-turn-result">
              {run.proposal && (
                <details className="ai-source" open={run.status === "ready" || run.status === "failed"}>
                  <summary>{run.proposal.operation === "create" ? "New file" : "Proposed changes"} · {run.proposal.path} · {run.validation.attempts} {run.validation.attempts === 1 ? "check" : "checks"}</summary>
                  <div className="ai-diff" role="table" aria-label="Proposed Manic diff">
                    {diffLines.map((line, index) => (
                      <div key={`${line.type}-${index}`} className={`ai-diff-line ${line.type}`}>
                        <span>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</span>
                        <code>{line.text || " "}</code>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {!run.validation.ok && run.validation.output && <pre className="ai-diagnostics">{run.validation.output}</pre>}
              {run.status === "ready" && (
                <div className="ai-actions">
                  <button className="primary" onClick={() => void act("open")}>{latestApplied ? "Open file" : "Apply & open"}</button>
                  <button onClick={() => void act("preview")}>Preview</button>
                  <button onClick={() => void act("render")}>Render…</button>
                </div>
              )}
              {run.prompt && (
                <footer className="ai-meta">
                  <span>Prompt {run.prompt.version.slice(0, 12)} · {run.prompt.source}</span>
                  <span>{run.usage.totalTokens === null ? "" : `${run.usage.totalTokens.toLocaleString()} tokens`}</span>
                </footer>
              )}
            </div>
          )}
          <div ref={transcriptEnd} />
        </div>
      </div>

      <div className="ai-composer">
        <div className="composer-card">
          <textarea
            value={message}
            rows={1}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={composerKeyDown}
            placeholder={hasConversation ? "Describe the next change…" : "Describe the animation you want…"}
            aria-label="Message Manic AI"
          />
          <div className="composer-row">
            <label className="composer-attach" title="Attach up to four reference images">
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => void attach(event.target.files)} />
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12.6 12.9 20a5.1 5.1 0 0 1-7.2-7.2l8-7.8a3.4 3.4 0 0 1 4.8 4.8l-7.6 7.4a1.7 1.7 0 0 1-2.4-2.4l6.8-6.6" /></svg>
              <span>Attach</span>
            </label>
            {images.map((image) => (
              <span key={image.name} className="composer-chip">{image.name}<button onClick={() => setImages((current) => current.filter((item) => item !== image))} aria-label={`Remove ${image.name}`}>×</button></span>
            ))}
            <span className="composer-spacer" />
            <label className="composer-reasoning" title="Reasoning effort for this message">
              <span>Reasoning · {REASONING_LABELS[reasoning]}</span>
              <input
                type="range"
                min={0}
                max={AI_REASONING_EFFORTS.length - 1}
                step={1}
                value={AI_REASONING_EFFORTS.indexOf(reasoning)}
                onChange={(event) => setReasoning(AI_REASONING_EFFORTS[Number(event.target.value)] ?? "none")}
                aria-label="Reasoning effort"
                aria-valuetext={REASONING_LABELS[reasoning]}
              />
            </label>
            <select
              className="composer-model"
              value={`${choice.provider}::${choice.model}`}
              onChange={(event) => {
                const [provider, ...rest] = event.target.value.split("::");
                setChoice({ provider: provider as AiProviderId, model: rest.join("::") });
              }}
              aria-label="Model"
            >
              {modelGroups.map((group) => (
                <optgroup key={group.provider} label={group.ready ? group.label : `${group.label} — API key required`}>
                  {group.models.map((model) => (
                    <option key={model} value={`${group.provider}::${model}`} disabled={!group.ready}>{model}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {busy
              ? <button className="composer-send stop" onClick={() => void cancelRun()} aria-label="Stop"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg></button>
              : <button className="composer-send" onClick={() => void sendTurn()} disabled={!canSend} aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg></button>}
          </div>
        </div>
        <p className="ai-privacy">
          {choiceReady
            ? "Your request, the current Manic source, compressed turn history, and images are sent to the selected provider. Preview and Render never start automatically."
            : `Add the ${providerSecretKey(choice.provider) ?? "provider"} secret in Settings to use ${choice.provider === "openai" ? "OpenAI" : "Anthropic"} models.`}
        </p>
      </div>
    </div>
  );
}

function initialChoice(settings: WorkbenchSettings, secrets: AiSecretStatus): ModelChoice {
  if (settings.ai.provider === "openai" || settings.ai.provider === "anthropic") {
    return { provider: settings.ai.provider, model: settings.ai.model };
  }
  const ready = PROVIDERS.find((provider) => providerConfigured(secrets, provider)) ?? "anthropic";
  return { provider: ready, model: modelsForProvider(ready, { openai: [], anthropic: [] })[0] ?? "" };
}

function providerConfigured(secrets: AiSecretStatus, provider: AiProviderId): boolean {
  const key = providerSecretKey(provider);
  return !!key && secretEntry(secrets, key).configured;
}

function normalizedPath(value: string): string {
  const path = value.trim();
  return path.toLowerCase().endsWith(".manic") ? path : `${path}.manic`;
}

function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Image could not be read."));
    reader.readAsDataURL(file);
  });
}
