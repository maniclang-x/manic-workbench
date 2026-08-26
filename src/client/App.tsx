import { useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  AI_REASONING_EFFORTS,
  DEFAULT_AI_MODELS,
  establishSession,
  modelsForProvider,
  providerSecretKey,
  secretEntry,
  suggestAssetsDirFromEnginePath,
  type AiProvider,
  type AiProviderId,
  type AiReasoningEffort,
  type AiSecretStatus,
  type Bootstrap,
  type EngineInstallMethod,
  type EngineInstallPlan,
  type EngineInstallResult,
  type ToolVersion,
  type WorkbenchSettings,
} from "./api";
import { WorkspaceEditor } from "./WorkspaceEditor";
import { AiWorkspace, type EditorOpenRequest } from "./AiWorkspace";

const sessionToken = establishSession();

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [settings, setSettings] = useState<WorkbenchSettings | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [message, setMessage] = useState("");
  const [view, setView] = useState<"settings" | "files" | "ai">("files");
  const [editorUnsafe, setEditorUnsafe] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [newSecretKey, setNewSecretKey] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [newModel, setNewModel] = useState("");
  const [savingSecret, setSavingSecret] = useState<string | null>(null);
  const [editorOpenRequest, setEditorOpenRequest] = useState<EditorOpenRequest | null>(null);
  const [installPlan, setInstallPlan] = useState<EngineInstallPlan | null>(null);
  const [installing, setInstalling] = useState<EngineInstallMethod | null>(null);
  const [installLog, setInstallLog] = useState("");
  const [installNotice, setInstallNotice] = useState("");
  const [newEnvKey, setNewEnvKey] = useState("MANIC_ASSETS_DIR");
  const [newEnvValue, setNewEnvValue] = useState("");

  const projectName = useMemo(() => data?.workspace.split(/[\\/]/u).filter(Boolean).at(-1) ?? "Project", [data]);
  const activeProvider = settings && settings.ai.provider !== "none" ? settings.ai.provider : null;
  const modelChoices = activeProvider && settings
    ? modelsForProvider(activeProvider, settings.ai.customModels)
    : [];

  useEffect(() => {
    if (!sessionToken) {
      setMessage("This page is not connected to a Workbench session. Start it again from the terminal.");
      setState("error");
      return;
    }
    void apiRequest<Bootstrap>(sessionToken, "/api/bootstrap")
      .then((bootstrap) => {
        setData(bootstrap);
        setSettings(bootstrap.settings);
        setState("ready");
      })
      .catch((error: Error) => {
        setMessage(error.message);
        setState("error");
      });
  }, []);

  useEffect(() => {
    if (view !== "settings" || !sessionToken) return;
    void apiRequest<{ plan: EngineInstallPlan }>(sessionToken, "/api/engine/install")
      .then((response) => setInstallPlan(response.plan))
      .catch(() => setInstallPlan(null));
  }, [view, data?.diagnostics.engine.available, settings?.updateChannel]);

  async function saveSettings() {
    if (!settings) return;
    setState("saving");
    setMessage("");
    try {
      const result = await apiRequest<{ settings: WorkbenchSettings; diagnostics: Bootstrap["diagnostics"] }>(
        sessionToken,
        "/api/settings",
        { method: "PUT", body: JSON.stringify(settings) },
      );
      setSettings(result.settings);
      setData((current) => current ? { ...current, settings: result.settings, diagnostics: result.diagnostics } : current);
      setState("saved");
      window.setTimeout(() => setState("ready"), 1600);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Settings could not be saved.");
      setState("error");
    }
  }

  async function switchProject() {
    if (editorUnsafe && !window.confirm("Some files have unsaved changes or conflicts. Switch projects and discard those open editor states?")) return;
    setPickingProject(true);
    setMessage("");
    try {
      const result = await apiRequest<{ workspace: string; cancelled: boolean }>(sessionToken, "/api/workspace/pick", { method: "POST" });
      if (result.cancelled) return;
      setData((current) => current ? { ...current, workspace: result.workspace } : current);
      setView("files");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project folder could not be opened.");
    } finally {
      setPickingProject(false);
    }
  }

  async function installEngine(method: EngineInstallMethod) {
    setInstalling(method);
    setInstallNotice("");
    setInstallLog("");
    setMessage("");
    try {
      const response = await apiRequest<{
        result: EngineInstallResult;
        settings: WorkbenchSettings;
        diagnostics: Bootstrap["diagnostics"];
      }>(sessionToken, "/api/engine/install", {
        method: "POST",
        body: JSON.stringify({ method }),
      });
      setSettings(response.settings);
      setData((current) => current
        ? { ...current, settings: response.settings, diagnostics: response.diagnostics }
        : current);
      setInstallLog(response.result.log);
      setInstallNotice(response.result.ok
        ? `Manic Engine is ready${response.result.binaryPath ? ` at ${response.result.binaryPath}` : "."}`
        : "Install finished with issues. Check the log below.");
      const plan = await apiRequest<{ plan: EngineInstallPlan }>(sessionToken, "/api/engine/install");
      setInstallPlan(plan.plan);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Manic could not be installed.";
      setInstallLog(text);
      setInstallNotice(text);
      setMessage(text);
    } finally {
      setInstalling(null);
    }
  }

  async function saveSecret(key: string, value: string, clear = false) {
    setSavingSecret(key);
    setMessage("");
    try {
      const result = await apiRequest<{ secrets: AiSecretStatus }>(sessionToken, "/api/ai/key", {
        method: "PUT",
        body: JSON.stringify({ key, value: clear ? "" : value }),
      });
      setData((current) => current ? { ...current, ai: result.secrets } : current);
      setSecretDrafts((current) => ({ ...current, [key]: "" }));
      if (key === newSecretKey.trim().toUpperCase()) {
        setNewSecretKey("");
        setNewSecretValue("");
      }
      setMessage(clear ? `${key} session value cleared.` : `${key} configured for this Workbench session.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "API key could not be configured.");
    } finally {
      setSavingSecret(null);
    }
  }

  function selectProvider(provider: AiProvider) {
    if (!settings) return;
    if (provider === "none") {
      setSettings({ ...settings, ai: { ...settings.ai, provider } });
      return;
    }
    const models = modelsForProvider(provider, settings.ai.customModels);
    const model = models.includes(settings.ai.model) ? settings.ai.model : DEFAULT_AI_MODELS[provider];
    setSettings({ ...settings, ai: { ...settings.ai, provider, model } });
    setNewModel("");
  }

  function addCustomModel() {
    if (!settings || !activeProvider) return;
    const model = newModel.trim();
    if (!model) return;
    if (!/^[A-Za-z0-9._:/-]+$/u.test(model)) {
      setMessage("Model ids may only use letters, numbers, and . _ : / -");
      return;
    }
    const existing = settings.ai.customModels[activeProvider];
    if (existing.includes(model) || modelChoices.includes(model)) {
      setSettings({ ...settings, ai: { ...settings.ai, model } });
      setNewModel("");
      return;
    }
    setSettings({
      ...settings,
      ai: {
        ...settings.ai,
        model,
        customModels: {
          ...settings.ai.customModels,
          [activeProvider]: [...existing, model],
        },
      },
    });
    setNewModel("");
  }

  function removeCustomModel(model: string) {
    if (!settings || !activeProvider) return;
    const nextCustom = settings.ai.customModels[activeProvider].filter((item) => item !== model);
    const nextModels = modelsForProvider(activeProvider, { ...settings.ai.customModels, [activeProvider]: nextCustom });
    const nextSelected = settings.ai.model === model ? (nextModels[0] ?? DEFAULT_AI_MODELS[activeProvider]) : settings.ai.model;
    setSettings({
      ...settings,
      ai: {
        ...settings.ai,
        model: nextSelected,
        customModels: { ...settings.ai.customModels, [activeProvider]: nextCustom },
      },
    });
  }

  if (state === "loading") return <Loading />;
  if (!data || !settings) return <Failure message={message} />;

  const displayedSecrets = [...data.ai.entries].sort((a, b) => a.key.localeCompare(b.key));

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand" aria-label="Manic Workbench">
          <img src="/manic-logo.png" alt="Manic" />
          <span><strong>Workbench</strong><small>Local creator</small></span>
        </div>

        <div className="project-block">
          <span className="eyebrow">LOCAL PROJECT</span>
          <strong>{projectName}</strong>
          <span className="path" title={data.workspace}>{data.workspace}</span>
          <button className="switch-project" onClick={() => void switchProject()} disabled={pickingProject}>{pickingProject ? "Choosing folder…" : "Open folder…"}</button>
        </div>

        <nav aria-label="Workbench sections">
          <button className={view === "files" ? "nav-item active" : "nav-item"} onClick={() => setView("files")}><Icon name="files" />Files</button>
          <button className={view === "settings" ? "nav-item active" : "nav-item"} onClick={() => setView("settings")}><Icon name="settings" />Settings</button>
          <button className="nav-item" onClick={() => setView("files")}><Icon name="preview" />Preview</button>
          <button className="nav-item" onClick={() => setView("files")}><Icon name="export" />Render</button>
          <button className={view === "ai" ? "nav-item active" : "nav-item"} onClick={() => setView("ai")}><Icon name="ai" />AI</button>
        </nav>

        <div className="rail-footer">
          <span className="status-dot" /> Local only
          <small>Nothing leaves this device unless you choose a provider.</small>
          <div className="product-links"><a href="https://maniclang.com" target="_blank" rel="noreferrer">Manic</a><a href="https://docs.maniclang.com" target="_blank" rel="noreferrer">Docs</a><a href="https://maniclang.com/#download" target="_blank" rel="noreferrer">Download</a><a href="https://github.com/maniclang-x/manic" target="_blank" rel="noreferrer">GitHub</a><a href="https://x.com/anish2good" target="_blank" rel="noreferrer">X · @anish2good</a><a href="https://www.reddit.com/r/maniclang/" target="_blank" rel="noreferrer">Reddit · r/maniclang</a></div>
        </div>
      </aside>

      <main className={view === "files" ? "main-workspace" : undefined}>
        {message && <div className="notice error">{message}</div>}
        {view === "files" ? <WorkspaceEditor key={data.workspace} token={sessionToken} workspace={data.workspace} settings={settings} onUnsafeChange={setEditorUnsafe} openRequest={editorOpenRequest} /> : view === "ai" ? <AiWorkspace token={sessionToken} settings={settings} secrets={data.ai} onSecretChange={(ai) => setData((current) => current ? { ...current, ai } : current)} onOpen={(request) => { setEditorOpenRequest(request); setView("files"); }} /> : <>
        <header>
          <div>
            <span className="eyebrow">SETTINGS</span>
            <h1>Make Manic yours.</h1>
            <p>Install or point to the Manic Engine, set preview defaults, and connect AI providers.</p>
          </div>
          <button className="save-button" onClick={() => void saveSettings()} disabled={state === "saving"}>
            {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Save settings"}
          </button>
        </header>

        <section className="version-grid" aria-label="Installed versions">
          <VersionCard label="Manic Workbench" version={`v${data.workbench.version}`} available />
          <VersionCard label="Manic Engine" tool={data.diagnostics.engine} />
          <VersionCard label="FFmpeg" tool={data.diagnostics.ffmpeg} />
        </section>

        <section className="settings-grid">
          <article className="panel span-two">
            <PanelHeading number="01" title="Engine" description="Choose the Manic executable Workbench controls." />
            <label className="field span-two">
              <span>Manic executable</span>
              <input
                value={settings.enginePath}
                placeholder="Use manic from PATH"
                onChange={(event) => {
                  const enginePath = event.target.value;
                  const suggested = suggestAssetsDirFromEnginePath(enginePath);
                  const nextEnv = { ...settings.engineEnv };
                  if (suggested && !settings.engineEnv.MANIC_ASSETS_DIR?.trim()) {
                    nextEnv.MANIC_ASSETS_DIR = suggested;
                  }
                  setSettings({ ...settings, enginePath, engineEnv: nextEnv });
                }}
              />
              <small>Leave empty to use MANIC_BIN or the manic command available on PATH. Archive layouts like <code>…/bin/manic</code> auto-fill <code>MANIC_ASSETS_DIR</code>.</small>
            </label>

            <div className="field span-two">
              <span>Manic environment</span>
              <div className="secret-table">
                <div className="secret-table-head"><span>Key</span><span>Value</span><span /></div>
                {Object.entries(settings.engineEnv).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => (
                  <div className="secret-row" key={key}>
                    <code>{key}</code>
                    <div className="secret-input">
                      <input
                        value={value}
                        onChange={(event) => setSettings({
                          ...settings,
                          engineEnv: { ...settings.engineEnv, [key]: event.target.value },
                        })}
                        placeholder={key === "MANIC_ASSETS_DIR" ? "…/share/manic/assets" : "value"}
                      />
                      <button
                        type="button"
                        className="secret-clear"
                        onClick={() => {
                          const next = { ...settings.engineEnv };
                          delete next[key];
                          setSettings({ ...settings, engineEnv: next });
                        }}
                      >
                        Remove
                      </button>
                    </div>
                    <small>Passed to manic</small>
                  </div>
                ))}
                <div className="secret-row secret-row-add">
                  <input
                    value={newEnvKey}
                    onChange={(event) => setNewEnvKey(event.target.value.toUpperCase())}
                    placeholder="MANIC_ASSETS_DIR"
                    aria-label="New Manic env key"
                  />
                  <div className="secret-input">
                    <input
                      value={newEnvValue}
                      onChange={(event) => setNewEnvValue(event.target.value)}
                      placeholder="value"
                      aria-label="New Manic env value"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const key = newEnvKey.trim().toUpperCase();
                        if (!/^MANIC_[A-Z0-9_]+$/u.test(key)) {
                          setMessage("Keys must look like MANIC_ASSETS_DIR.");
                          return;
                        }
                        setSettings({
                          ...settings,
                          engineEnv: { ...settings.engineEnv, [key]: newEnvValue },
                        });
                        setNewEnvKey("MANIC_");
                        setNewEnvValue("");
                      }}
                      disabled={!newEnvKey.trim()}
                    >
                      Add
                    </button>
                  </div>
                  <small>
                    {suggestAssetsDirFromEnginePath(settings.enginePath) && !settings.engineEnv.MANIC_ASSETS_DIR ? (
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => {
                          const suggested = suggestAssetsDirFromEnginePath(settings.enginePath);
                          if (!suggested) return;
                          setSettings({
                            ...settings,
                            engineEnv: { ...settings.engineEnv, MANIC_ASSETS_DIR: suggested },
                          });
                        }}
                      >
                        Use suggested assets dir
                      </button>
                    ) : "Save settings to apply"}
                  </small>
                </div>
              </div>
              <small>These <code>MANIC_*</code> variables are merged into the environment for preview, render, check, and version probes. Save settings after editing.</small>
            </div>

            <label className="field">
              <span>Release channel</span>
              <select
                value={settings.updateChannel}
                onChange={(event) => setSettings({ ...settings, updateChannel: event.target.value as "stable" | "latest" })}
              >
                <option value="stable">Stable</option>
                <option value="latest">Latest, including release candidates</option>
              </select>
            </label>
            <Toggle
              label="Check for updates"
              description="A quiet, cached check that never interrupts rendering."
              checked={settings.updateChecks}
              onChange={(checked) => setSettings({ ...settings, updateChecks: checked })}
            />

            <div className="field span-two engine-install">
              <span>Install Manic Engine</span>
              {data.diagnostics.engine.available ? (
                <p className="engine-install-ready">
                  Detected: <code>{data.diagnostics.engine.command}</code>
                  {data.diagnostics.engine.version ? ` · ${data.diagnostics.engine.version}` : ""}
                </p>
              ) : (
                <p className="engine-install-missing">
                  Manic is not available yet. Install it here using the selected release channel,
                  or paste a path above after a manual install.
                </p>
              )}
              {installPlan && (
                <>
                  <div className="engine-install-methods">
                    {installPlan.methods.map((method) => (
                      <button
                        key={method.id}
                        type="button"
                        className="engine-install-method"
                        disabled={!method.available || installing !== null}
                        onClick={() => void installEngine(method.id)}
                      >
                        <strong>{installing === method.id ? "Installing…" : method.label}</strong>
                        <small>{method.description}</small>
                        {method.detail && <em>{method.detail}</em>}
                      </button>
                    ))}
                  </div>
                  <small>
                    Channel: <code>{settings.updateChannel}</code>
                    {" · "}Default path hint: <code>{installPlan.defaultBinaryHint}</code>
                    {" · "}
                    <a href={installPlan.docsUrl} target="_blank" rel="noreferrer">Install docs</a>
                    {" · "}
                    <a href={installPlan.releasesUrl} target="_blank" rel="noreferrer">Releases</a>
                  </small>
                  <details className="engine-install-manual">
                    <summary>Manual command</summary>
                    <code>{installPlan.manualCommand}</code>
                  </details>
                </>
              )}
              {installNotice && <p className={installNotice.includes("ready") ? "engine-install-ready" : "engine-install-missing"}>{installNotice}</p>}
              {installLog && <pre className="engine-install-log">{installLog}</pre>}
            </div>
          </article>

          <article className="panel span-two">
            <PanelHeading number="02" title="Preview defaults" description="These become the starting point for every local preview." />
            <label className="field">
              <span>Frames per second</span>
              <input
                type="number" min="1" max="240" value={settings.preview.fps}
                onChange={(event) => updatePreview("fps", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Render scale</span>
              <input
                type="number" min="0.1" max="8" step="0.1" value={settings.preview.scale}
                onChange={(event) => updatePreview("scale", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Canvas</span>
              <select
                value={settings.preview.canvas}
                onChange={(event) => updatePreview("canvas", event.target.value as WorkbenchSettings["preview"]["canvas"])}
              >
                <option value="auto">Use the story</option>
                <option value="portrait">Portrait</option>
                <option value="feed">Feed</option>
                <option value="square">Square</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            <Toggle
              label="CPU shaders"
              description="Prefer compatibility when GPU shaders are unavailable."
              checked={settings.preview.cpuShaders}
              onChange={(checked) => updatePreview("cpuShaders", checked)}
            />
          </article>

          <article className="panel span-two">
            <PanelHeading number="03" title="AI provider" description="Enable a provider, choose or add a model, then configure API keys as local key/value secrets." />
            <div className="provider-row">
              <button type="button" className={settings.ai.provider === "none" ? "provider selected" : "provider"} onClick={() => selectProvider("none")}><span>—</span><strong>Off</strong><small>Local editing only</small></button>
              <button type="button" className={settings.ai.provider === "openai" ? "provider selected" : "provider"} onClick={() => selectProvider("openai")}><span>O</span><strong>OpenAI</strong><small>Official API or local: Ollama, LM Studio, vLLM…</small></button>
              <button type="button" className={settings.ai.provider === "anthropic" ? "provider selected" : "provider"} onClick={() => selectProvider("anthropic")}><span>A</span><strong>Anthropic</strong><small>Claude messages API</small></button>
            </div>

            {activeProvider && <>
              <label className="field">
                <span>{providerLabel(activeProvider)} model</span>
                <select
                  value={modelChoices.includes(settings.ai.model) ? settings.ai.model : modelChoices[0] ?? ""}
                  onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, model: event.target.value } })}
                >
                  {modelChoices.map((model) => (
                    <option key={model} value={model}>{model}{settings.ai.customModels[activeProvider].includes(model) ? " · custom" : ""}</option>
                  ))}
                </select>
                <small>Pick a listed model, or add a custom model id below. Vision models are recommended when attaching reference images.</small>
              </label>

              {activeProvider === "openai" && (
                <label className="field">
                  <span>Reasoning</span>
                  <select
                    value={settings.ai.reasoning}
                    onChange={(event) => setSettings({
                      ...settings,
                      ai: { ...settings.ai, reasoning: event.target.value as AiReasoningEffort },
                    })}
                  >
                    {AI_REASONING_EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>{effort}</option>
                    ))}
                  </select>
                  <small>Controls OpenAI reasoning effort for gpt-5.6 models. Use none for the cheapest smoke tests.</small>
                </label>
              )}

              {activeProvider === "openai" && (
                <label className="field span-two">
                  <span>Base URL (OpenAI-compatible)</span>
                  <input
                    value={settings.ai.baseUrl}
                    placeholder="Leave empty for api.openai.com · http://localhost:11434/v1 for Ollama"
                    onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, baseUrl: event.target.value } })}
                  />
                  <small>
                    Point Workbench at any OpenAI-compatible Chat Completions server — Ollama, LM Studio, vLLM,
                    llama.cpp. Add the model id (e.g. qwen2.5-coder:14b) under Add model. Local endpoints
                    don&apos;t need an API key; reasoning effort is skipped for compatible servers.
                  </small>
                </label>
              )}

              <div className="field">
                <span>Add model</span>
                <div className="secret-input">
                  <input value={newModel} onChange={(event) => setNewModel(event.target.value)} placeholder={activeProvider === "openai" ? "gpt-… or your fine-tune id" : "claude-…"} />
                  <button type="button" onClick={addCustomModel} disabled={!newModel.trim()}>Add</button>
                </div>
                {settings.ai.customModels[activeProvider].length > 0 && (
                  <div className="model-chip-list">
                    {settings.ai.customModels[activeProvider].map((model) => (
                      <span key={model} className="model-chip">
                        {model}
                        <button type="button" aria-label={`Remove ${model}`} onClick={() => removeCustomModel(model)}>×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {(() => {
                if (activeProvider === "openai" && settings.ai.baseUrl.trim()) {
                  return (
                    <p className="ai-provider-hint ready">
                      Using the OpenAI-compatible endpoint {settings.ai.baseUrl.trim()} — an API key is optional.
                    </p>
                  );
                }
                const required = providerSecretKey(activeProvider);
                const entry = required ? secretEntry(data.ai, required) : null;
                return entry ? (
                  <p className={`ai-provider-hint ${entry.configured ? "ready" : ""}`}>
                    {entry.configured
                      ? `${required} is ready (${entry.source}).`
                      : `Set ${required} below before generating with ${providerLabel(activeProvider)}.`}
                  </p>
                ) : null;
              })()}
            </>}

            <div className="field span-two">
              <span>API keys</span>
              <div className="secret-table">
                <div className="secret-table-head"><span>Key</span><span>Value</span><span>Status</span></div>
                {displayedSecrets.map((entry) => {
                  const draft = secretDrafts[entry.key] ?? "";
                  return (
                    <div className="secret-row" key={entry.key}>
                      <code>{entry.key}</code>
                      <div className="secret-input">
                        <input
                          type="password"
                          autoComplete="off"
                          value={draft}
                          onChange={(event) => setSecretDrafts((current) => ({ ...current, [entry.key]: event.target.value }))}
                          placeholder={entry.configured ? "Configured — enter a replacement" : "secret value"}
                        />
                        <button type="button" onClick={() => void saveSecret(entry.key, draft)} disabled={savingSecret === entry.key || !draft.trim()}>
                          {savingSecret === entry.key ? "…" : "Set"}
                        </button>
                        {entry.source === "session" && (
                          <button type="button" className="secret-clear" onClick={() => void saveSecret(entry.key, "", true)} disabled={savingSecret === entry.key}>
                            Clear
                          </button>
                        )}
                      </div>
                      <small>{entry.source === "environment" ? "From process env" : entry.source === "session" ? "Session only" : "Not set"}</small>
                    </div>
                  );
                })}
                <div className="secret-row secret-row-add">
                  <input
                    value={newSecretKey}
                    onChange={(event) => setNewSecretKey(event.target.value.toUpperCase())}
                    placeholder="CUSTOM_API_KEY"
                    aria-label="New secret key"
                  />
                  <div className="secret-input">
                    <input
                      type="password"
                      autoComplete="off"
                      value={newSecretValue}
                      onChange={(event) => setNewSecretValue(event.target.value)}
                      placeholder="value"
                      aria-label="New secret value"
                    />
                    <button
                      type="button"
                      onClick={() => void saveSecret(newSecretKey, newSecretValue)}
                      disabled={savingSecret === newSecretKey.trim().toUpperCase() || !newSecretKey.trim() || !newSecretValue.trim()}
                    >
                      Add
                    </button>
                  </div>
                  <small>Session K/V</small>
                </div>
              </div>
              <small>Keys stay in the local Workbench server process. They are never written to projects, browser storage, or settings.json. Environment variables still win until you set a session override.</small>
            </div>
          </article>
        </section>

        <footer>
          <span>Settings: {data.settingsPath}</span>
          <span>Bound to this local session</span>
        </footer>
        </>}
      </main>
    </div>
  );

  function updatePreview<K extends keyof WorkbenchSettings["preview"]>(key: K, value: WorkbenchSettings["preview"][K]) {
    if (!settings) return;
    setSettings({ ...settings, preview: { ...settings.preview, [key]: value } });
  }
}

function providerLabel(provider: AiProviderId): string {
  return provider === "openai" ? "OpenAI" : "Anthropic";
}

function Loading() {
  return <div className="center-state"><div className="loader" /><strong>Opening your Workbench…</strong></div>;
}

function Failure({ message }: { message: string }) {
  return <div className="center-state failure"><span>Session unavailable</span><h1>Open Workbench from your terminal.</h1><p>{message}</p></div>;
}

function VersionCard({ label, version, available, tool }: { label: string; version?: string; available?: boolean; tool?: ToolVersion }) {
  const isAvailable = available ?? tool?.available ?? false;
  return (
    <article className="version-card">
      <span className={isAvailable ? "availability good" : "availability"}>{isAvailable ? "Ready" : "Missing"}</span>
      <small>{label}</small>
      <strong>{version ?? tool?.version ?? "Not detected"}</strong>
      {tool?.detail && <p>{tool.detail}</p>}
    </article>
  );
}

function PanelHeading({ number, title, description }: { number: string; title: string; description: string }) {
  return <div className="panel-heading span-two"><span>{number}</span><div><h2>{title}</h2><p>{description}</p></div></div>;
}

function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <label className="toggle-field">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    settings: "M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5ZM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.5 2.6-.1-.03a1.7 1.7 0 0 0-1.78.27 1.7 1.7 0 0 0-.62 1.63v.09h-3v-.09a1.7 1.7 0 0 0-.62-1.63 1.7 1.7 0 0 0-1.78-.27l-.1.03-1.5-2.6.06-.06A1.7 1.7 0 0 0 9.3 15a1.7 1.7 0 0 0-1.17-1.25L8 13.72v-3l.13-.03A1.7 1.7 0 0 0 9.3 9.45a1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.5-2.6.1.03a1.7 1.7 0 0 0 1.78-.27A1.7 1.7 0 0 0 12.9 3V3h3v.09a1.7 1.7 0 0 0 .62 1.63 1.7 1.7 0 0 0 1.78.27l.1-.03 1.5 2.6-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.17 1.25l.13.03v3l-.13.03A1.7 1.7 0 0 0 19.4 15Z",
    files: "M4 5.5h6l2 2h8v11H4v-13Z", preview: "m5 4 14 8-14 8V4Z", export: "M12 3v12m0-12 4 4m-4-4L8 7M5 14v6h14v-6", ai: "m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Zm6 11 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z",
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}
