import Editor, { loader } from "@monaco-editor/react";
// The full monaco entry (not esm/vs/editor/editor.api) — the slim API ships no
// editor contributions, which silently removes the suggest widget: completion
// providers run but nothing can render their items.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, type EngineCheckResult, type PreviewResult, type RenderFormat, type RenderJob, type WorkbenchSettings, type WorkspaceFile, type WorkspaceFileSummary } from "./api";
import { loadManicLanguage, type ManicDiagnostic, type ManicLanguageService } from "./manicLanguage";
import type { EditorOpenRequest } from "./AiWorkspace";
import { VisualCanvas } from "./VisualCanvas";

type SaveState = "clean" | "dirty" | "saving" | "saved" | "conflict" | "error";
interface OpenFile extends WorkspaceFile { saveState: SaveState; message: string; }
interface VisibleDiagnostic extends ManicDiagnostic { line: number; column: number; }
interface ContextMenuState { path: string; x: number; y: number; }
interface RenderOptions { format: RenderFormat; fps: number; scale: number; canvas: WorkbenchSettings["preview"]["canvas"]; cpuShaders: boolean; branded: boolean; }

loader.config({ monaco });
(globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker(): Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export function WorkspaceEditor({ token, workspace, settings, onUnsafeChange, openRequest }: { token: string; workspace: string; settings: WorkbenchSettings; onUnsafeChange?(unsafe: boolean): void; openRequest?: EditorOpenRequest | null }) {
  const [files, setFiles] = useState<WorkspaceFileSummary[]>([]);
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [languageState, setLanguageState] = useState<"loading" | "ready" | "fallback">("loading");
  const [diagnosticCount, setDiagnosticCount] = useState(0);
  const [diagnostics, setDiagnostics] = useState<VisibleDiagnostic[]>([]);
  const [editorMounted, setEditorMounted] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const [renderOptions, setRenderOptions] = useState<RenderOptions>({ format: "mp4", fps: settings.preview.fps, scale: settings.preview.scale, canvas: settings.preview.canvas, cpuShaders: settings.preview.cpuShaders, branded: true });
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);
  const [renderMedia, setRenderMedia] = useState("");
  const [renderMediaJobId, setRenderMediaJobId] = useState("");
  const [renderHistory, setRenderHistory] = useState<RenderJob[]>([]);
  const [engineCheck, setEngineCheck] = useState<EngineCheckResult | null>(null);
  const [checkingEngine, setCheckingEngine] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"canvas" | "source">("canvas");
  const tabsRef = useRef(tabs);
  const timers = useRef(new Map<string, number>());
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const languageRef = useRef<ManicLanguageService | null>(null);
  tabsRef.current = tabs;

  const active = tabs.find((tab) => tab.path === activePath) ?? null;
  const projectName = useMemo(() => workspace.split(/[\\/]/u).filter(Boolean).at(-1) ?? "Project", [workspace]);

  useEffect(() => {
    loader.init().then(async (monaco) => {
      if (!monaco.languages.getLanguages().some((language) => language.id === "manic")) {
        monaco.languages.register({ id: "manic", extensions: [".manic"] });
        monaco.languages.setMonarchTokensProvider("manic", {
          tokenizer: {
            root: [
              [/\/\/.*$/, "comment"],
              [/[a-zA-Z_][\w]*(?=\s*\()/, "keyword"],
              [/\b(let|if|else|for|in|par|seq|step|wait|true|false)\b/, "keyword"],
              [/"(?:[^"\\]|\\.)*"/, "string"],
              [/-?\d+(?:\.\d+)?/, "number"],
            ],
          },
        });
      }
      monaco.editor.defineTheme("manic-dark", {
        base: "vs-dark", inherit: true,
        rules: [
          { token: "builtin", foreground: "00E6FF" }, { token: "keyword", foreground: "FF2D95" },
          { token: "constant", foreground: "FFD166" }, { token: "color", foreground: "7CFF6B" },
          { token: "ease", foreground: "7CFF6B" }, { token: "string", foreground: "FFD166" },
          { token: "number", foreground: "9BE7FF" }, { token: "variable", foreground: "E0E1F3" },
          { token: "comment", foreground: "6B6890", fontStyle: "italic" },
        ],
        colors: { "editor.background": "#11151d", "editorLineNumber.foreground": "#4b5260" },
      });
      try {
        languageRef.current = await loadManicLanguage(monaco);
        setLanguageState("ready");
      } catch (error) {
        setLanguageState("fallback");
        setMessage(`Using basic syntax support: ${error instanceof Error ? error.message : "language service unavailable"}`);
      }
    }).catch(() => setLanguageState("fallback"));
  }, []);

  useEffect(() => {
    void refreshFiles(true);
    return () => timers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (!openRequest) return;
    void (async () => {
      await openFile(openRequest.path);
      if (openRequest.action === "render") {
        setRenderOpen(true);
        await loadRenderHistory();
      }
    })();
  }, [openRequest?.nonce]);

  useEffect(() => {
    const interval = window.setInterval(() => void checkExternalChanges(), 3000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsafe = tabs.some((tab) => ["dirty", "saving", "conflict", "error"].includes(tab.saveState));
    onUnsafeChange?.(unsafe);
  }, [tabs, onUnsafeChange]);

  useEffect(() => () => onUnsafeChange?.(false), [onUnsafeChange]);

  useEffect(() => {
    if (!renderJob || !["queued", "running"].includes(renderJob.status)) return;
    const timer = window.setInterval(() => void pollRender(renderJob.id), 650);
    return () => window.clearInterval(timer);
  }, [renderJob?.id, renderJob?.status]);

  useEffect(() => () => { if (renderMedia) URL.revokeObjectURL(renderMedia); }, [renderMedia]);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && !event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault(); void createFile();
      } else if (command && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault(); void saveAs();
      } else if (command && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault(); void duplicateFile(activePath);
      } else if (event.key === "F2") {
        event.preventDefault(); void renameFile(activePath);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePath, tabs]);

  useEffect(() => {
    const editor = editorRef.current;
    const service = languageRef.current;
    if (!active || !editor || !service) return;
    const timer = window.setTimeout(() => {
      const model = editor.getModel();
      if (!model || model.getValue() !== active.content) return;
      const nextDiagnostics = service.check(active.content).map((diagnostic) => {
        const position = model.getPositionAt(diagnostic.start);
        return { ...diagnostic, line: position.lineNumber, column: position.column };
      });
      setDiagnostics(nextDiagnostics);
      setDiagnosticCount(nextDiagnostics.length);
      monaco.editor.setModelMarkers(model, "manic", nextDiagnostics.map((diagnostic) => {
        const start = model.getPositionAt(diagnostic.start);
        const end = model.getPositionAt(diagnostic.start + Math.max(1, diagnostic.len));
        return {
          severity: diagnostic.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
          message: diagnostic.message,
          startLineNumber: start.lineNumber, startColumn: start.column,
          endLineNumber: end.lineNumber, endColumn: end.column,
        };
      }));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [active?.path, active?.content, languageState, editorMounted]);

  useEffect(() => {
    setDiagnostics([]);
    setDiagnosticCount(0);
    setEngineCheck(null);
  }, [active?.path]);

  async function refreshFiles(openFirst = false) {
    try {
      const result = await apiRequest<{ files: WorkspaceFileSummary[] }>(token, "/api/files");
      setFiles(result.files);
      setLoading(false);
      if (openFirst && result.files[0]) await openFile(result.files[0].path);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project files could not be loaded.");
      setLoading(false);
    }
  }

  async function openFile(path: string) {
    const existing = tabsRef.current.find((tab) => tab.path === path);
    if (existing) {
      setActivePath(path);
      return;
    }
    try {
      const result = await apiRequest<{ file: WorkspaceFile }>(token, `/api/file?path=${encodeURIComponent(path)}`);
      setTabs((current) => [...current, { ...result.file, saveState: "clean", message: "" }]);
      setActivePath(path);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "File could not be opened.");
    }
  }

  function closeFile(path: string) {
    const tab = tabsRef.current.find((candidate) => candidate.path === path);
    if (tab && ["dirty", "saving", "conflict", "error"].includes(tab.saveState)) {
      setMessage(`Save or reload ${tab.name} before closing it.`);
      return;
    }
    const remaining = tabsRef.current.filter((candidate) => candidate.path !== path);
    setTabs(remaining);
    if (activePath === path) setActivePath(remaining.at(-1)?.path ?? "");
  }

  function editFile(content: string) {
    if (!active) return;
    setTabs((current) => current.map((tab) => tab.path === active.path
      ? { ...tab, content, saveState: tab.saveState === "conflict" ? "conflict" : "dirty", message: "" }
      : tab));
    if (active.saveState !== "conflict") scheduleSave(active.path);
  }

  function scheduleSave(path: string) {
    const previous = timers.current.get(path);
    if (previous) window.clearTimeout(previous);
    timers.current.set(path, window.setTimeout(() => void saveFile(path), 700));
  }

  async function saveFile(path: string) {
    const tab = tabsRef.current.find((candidate) => candidate.path === path);
    if (!tab || tab.saveState === "conflict" || tab.saveState === "saving") return;
    const requestedContent = tab.content;
    const expectedVersion = tab.version;
    setTabs((current) => current.map((candidate) => candidate.path === path ? { ...candidate, saveState: "saving" } : candidate));
    try {
      const result = await apiRequest<{ file: WorkspaceFile }>(token, "/api/file", {
        method: "PUT",
        body: JSON.stringify({ path, content: requestedContent, expectedVersion }),
      });
      setTabs((current) => current.map((candidate) => {
        if (candidate.path !== path) return candidate;
        const changedAgain = candidate.content !== requestedContent;
        return { ...candidate, ...result.file, content: candidate.content, saveState: changedAgain ? "dirty" : "saved", message: "" };
      }));
      setFiles((current) => current.map((file) => file.path === path ? withoutContent(result.file) : file));
      const latest = tabsRef.current.find((candidate) => candidate.path === path);
      if (latest && latest.content !== requestedContent) scheduleSave(path);
      else window.setTimeout(() => setTabs((current) => current.map((candidate) => candidate.path === path && candidate.saveState === "saved" ? { ...candidate, saveState: "clean" } : candidate)), 1000);
    } catch (error) {
      const conflict = error instanceof Error && error.message.includes("changed outside Workbench");
      setTabs((current) => current.map((candidate) => candidate.path === path
        ? { ...candidate, saveState: conflict ? "conflict" : "error", message: error instanceof Error ? error.message : "Autosave failed." }
        : candidate));
    }
  }

  async function checkExternalChanges() {
    const open = tabsRef.current;
    await Promise.all(open.map(async (tab) => {
      try {
        const result = await apiRequest<{ file: WorkspaceFile }>(token, `/api/file?path=${encodeURIComponent(tab.path)}`);
        if (result.file.version === tab.version) return;
        setTabs((current) => current.map((candidate) => {
          if (candidate.path !== tab.path || candidate.version === result.file.version) return candidate;
          if (["clean", "saved"].includes(candidate.saveState)) return { ...result.file, saveState: "clean", message: "Updated from disk." };
          return { ...candidate, saveState: "conflict", message: "This file changed on disk while you were editing it." };
        }));
      } catch { /* The next explicit action will surface an actionable error. */ }
    }));
  }

  async function reloadFile(path: string) {
    try {
      const result = await apiRequest<{ file: WorkspaceFile }>(token, `/api/file?path=${encodeURIComponent(path)}`);
      setTabs((current) => current.map((tab) => tab.path === path ? { ...result.file, saveState: "clean", message: "Reloaded from disk." } : tab));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "File could not be reloaded.");
    }
  }

  function autoFix() {
    const editor = editorRef.current;
    const service = languageRef.current;
    if (!active || !editor || !service) return;
    const result = service.autofix(active.content);
    if (!result.fixed || result.code === active.content) {
      setMessage("No auto-fixable problems were found.");
      return;
    }
    editor.executeEdits("manic-autofix", [{ range: editor.getModel()!.getFullModelRange(), text: result.code, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    setMessage(`Applied ${result.fixed} Manic ${result.fixed === 1 ? "fix" : "fixes"}.`);
  }

  async function previewFile() {
    if (!active || checkingEngine) return;
    if (!["clean", "saved"].includes(active.saveState)) {
      setMessage("Wait for autosave or resolve the file conflict before previewing."); return;
    }
    setCheckingEngine(true);
    setEngineCheck(null);
    setMessage(`Checking ${active.name} with Manic before preview…`);
    try {
      const result = await apiRequest<PreviewResult>(token, "/api/preview", { method: "POST", body: JSON.stringify({ path: active.path }) });
      if (!result.started) {
        setEngineCheck(result.check);
        setMessage("Preview stopped because Manic found errors. Fix them and try again.");
        return;
      }
      setMessage(`Preview opened for ${active.name}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Preview could not be opened."); }
    finally { setCheckingEngine(false); }
  }

  async function checkWithManic() {
    if (!active) return;
    if (!["clean", "saved"].includes(active.saveState)) {
      setMessage("Wait for autosave or resolve the file conflict before running Manic check."); return;
    }
    setCheckingEngine(true);
    try {
      const result = await apiRequest<EngineCheckResult>(token, "/api/check", { method: "POST", body: JSON.stringify({ path: active.path }) });
      setEngineCheck(result);
      setMessage(result.ok ? "Manic check passed." : "Manic found issues. Full engine output is shown below.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Manic check could not be run."); }
    finally { setCheckingEngine(false); }
  }

  function chooseRender() {
    if (!active) return;
    if (!["clean", "saved"].includes(active.saveState)) {
      setMessage("Wait for autosave or resolve the file conflict before rendering."); return;
    }
    setRenderOpen(true);
    void loadRenderHistory();
  }

  async function loadRenderHistory() {
    try {
      const result = await apiRequest<{ jobs: RenderJob[] }>(token, "/api/renders");
      setRenderHistory(result.jobs);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Render history could not be loaded."); }
  }

  async function startRender() {
    if (!active) return;
    if (renderMedia) { URL.revokeObjectURL(renderMedia); setRenderMedia(""); }
    try {
      const result = await apiRequest<{ job: RenderJob }>(token, "/api/render", {
        method: "POST", body: JSON.stringify({ path: active.path, options: renderOptions }),
      });
      setRenderJob(result.job);
      setRenderHistory((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Render could not be started."); }
  }

  async function pollRender(id: string) {
    try {
      const result = await apiRequest<{ job: RenderJob }>(token, `/api/render/${encodeURIComponent(id)}`);
      setRenderJob(result.job);
      setRenderHistory((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)].sort((left, right) => right.startedAt - left.startedAt));
      if (result.job.status === "completed" && renderMediaJobId !== result.job.id) await loadRenderOutput(result.job);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Render status is unavailable."); }
  }

  async function loadRenderOutput(job: RenderJob) {
    if (renderMedia) URL.revokeObjectURL(renderMedia);
    setRenderMedia("");
    setRenderMediaJobId(job.id);
    const response = await fetch(`/api/render/${encodeURIComponent(job.id)}/output`, { headers: { "X-Manic-Session": token } });
    if (!response.ok) throw new Error("The completed output could not be loaded.");
    setRenderMedia(URL.createObjectURL(await response.blob()));
  }

  async function cancelRender() {
    if (!renderJob) return;
    const result = await apiRequest<{ job: RenderJob }>(token, `/api/render/${encodeURIComponent(renderJob.id)}`, { method: "DELETE" });
    setRenderJob(result.job);
    setRenderHistory((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)].sort((left, right) => right.startedAt - left.startedAt));
  }

  async function selectRender(job: RenderJob) {
    setRenderJob(job);
    if (job.status === "completed") await loadRenderOutput(job);
    else { if (renderMedia) URL.revokeObjectURL(renderMedia); setRenderMedia(""); setRenderMediaJobId(""); }
  }

  /** Canvas → "Edit in Source": switch modes and land Monaco on the statement. */
  function revealSourceOffset(offset: number) {
    setWorkspaceMode("source");
    window.setTimeout(() => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return;
      const position = model.getPositionAt(offset);
      editor.revealPositionInCenter(position);
      editor.setPosition(position);
      editor.focus();
    }, 250);
  }

  function revealDiagnostic(diagnostic: VisibleDiagnostic) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealPositionInCenter({ lineNumber: diagnostic.line, column: diagnostic.column });
    editor.setPosition({ lineNumber: diagnostic.line, column: diagnostic.column });
    editor.focus();
  }

  async function createFile() {
    const requested = window.prompt("New Manic file", "story.manic");
    if (requested === null) return;
    const path = normalizedPromptPath(requested);
    if (!path) return setMessage("Enter a name for the new .manic file.");
    const title = path.split("/").at(-1)!.replace(/\.manic$/iu, "").replaceAll(/[-_]+/gu, " ");
    const content = `title("${escapeManicString(title || "Untitled")}");\ncanvas("16:9");\n\n// Build your story here.\n`;
    await createFromContent(path, content);
  }

  async function createFromContent(path: string, content: string) {
    try {
      const result = await apiRequest<{ file: WorkspaceFile }>(token, "/api/file", {
        method: "POST", body: JSON.stringify({ path, content }),
      });
      setTabs((current) => [...current, { ...result.file, saveState: "clean", message: "Created." }]);
      setActivePath(result.file.path);
      await refreshFiles();
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "File could not be created.");
    }
  }

  async function renameFile(path: string) {
    if (!path) return;
    const source = await fileForOperation(path);
    if (!source) return;
    if (!["clean", "saved"].includes(source.saveState)) return setMessage("Wait for autosave or resolve the file conflict before renaming.");
    const requested = window.prompt("Rename Manic file", source.path);
    if (requested === null) return;
    const newPath = normalizedPromptPath(requested);
    if (!newPath || newPath === source.path) return;
    try {
      const result = await apiRequest<{ file: WorkspaceFile }>(token, "/api/file/rename", {
        method: "POST", body: JSON.stringify({ path: source.path, newPath, expectedVersion: source.version }),
      });
      setTabs((current) => current.map((tab) => tab.path === source.path ? { ...result.file, saveState: "clean", message: "Renamed." } : tab));
      if (activePath === source.path) setActivePath(result.file.path);
      await refreshFiles();
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "File could not be renamed.");
    }
  }

  async function duplicateFile(path: string) {
    if (!path) return;
    const source = await fileForOperation(path);
    if (!source) return;
    if (!["clean", "saved"].includes(source.saveState)) return setMessage("Wait for autosave or resolve the file conflict before duplicating.");
    const requested = window.prompt("Duplicate as", suggestedCopyPath(source.path));
    if (requested === null) return;
    const newPath = normalizedPromptPath(requested);
    if (!newPath) return;
    await duplicateTo(source, newPath, undefined, "Duplicated.");
  }

  async function saveAs() {
    if (!active) return;
    if (["saving", "conflict", "error"].includes(active.saveState)) return setMessage("Resolve the current save state before using Save As.");
    const requested = window.prompt("Save a copy as", suggestedCopyPath(active.path));
    if (requested === null) return;
    const newPath = normalizedPromptPath(requested);
    if (!newPath) return;
    await duplicateTo(active, newPath, active.content, "Saved as a new file.");
  }

  async function duplicateTo(source: OpenFile, newPath: string, content: string | undefined, successMessage: string) {
    try {
      const result = await apiRequest<{ file: WorkspaceFile }>(token, "/api/file/duplicate", {
        method: "POST", body: JSON.stringify({ path: source.path, newPath, expectedVersion: source.version, content }),
      });
      setTabs((current) => [...current, { ...result.file, saveState: "clean", message: successMessage }]);
      setActivePath(result.file.path);
      await refreshFiles();
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "File could not be duplicated.");
    }
  }

  async function deleteFile(path: string) {
    if (!path) return;
    const source = await fileForOperation(path);
    if (!source) return;
    if (source.saveState === "saving") return setMessage("Wait for the current save to finish before moving this file to trash.");
    const losesEdits = !["clean", "saved"].includes(source.saveState);
    const warning = losesEdits ? " Unsaved editor changes will be discarded." : "";
    if (!window.confirm(`Move ${source.path} to the project trash?${warning}`)) return;
    const pendingSave = timers.current.get(source.path);
    if (pendingSave) window.clearTimeout(pendingSave);
    timers.current.delete(source.path);
    try {
      const result = await apiRequest<{ path: string; trashedPath: string }>(token, "/api/file", {
        method: "DELETE", body: JSON.stringify({ path: source.path, expectedVersion: source.version }),
      });
      const remaining = tabsRef.current.filter((tab) => tab.path !== source.path);
      setTabs(remaining);
      if (activePath === source.path) setActivePath(remaining.at(-1)?.path ?? "");
      await refreshFiles();
      setMessage(`${source.name} moved to ${result.trashedPath}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "File could not be moved to project trash.");
    }
  }

  async function fileForOperation(path: string): Promise<OpenFile | null> {
    const open = tabsRef.current.find((tab) => tab.path === path);
    if (open) return open;
    try {
      const result = await apiRequest<{ file: WorkspaceFile }>(token, `/api/file?path=${encodeURIComponent(path)}`);
      return { ...result.file, saveState: "clean", message: "" };
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "File could not be opened.");
      return null;
    }
  }

  return (
    <div className="workspace-view">
      <header className="workspace-header">
        <div><span className="eyebrow">PROJECT · {projectName.toUpperCase()}</span><h1>Write with Manic.</h1></div>
        <div className="editor-actions">
          <div className="workspace-mode-switch" aria-label="Workbench mode">
            <button className={workspaceMode === "canvas" ? "active" : ""} onClick={() => setWorkspaceMode("canvas")}>Canvas</button>
            <button className={workspaceMode === "source" ? "active" : ""} onClick={() => setWorkspaceMode("source")}>Source</button>
          </div>
          <span className={`language-label ${languageState}`}>{languageState === "ready" ? `Issues · ${diagnosticCount}` : languageState === "fallback" ? "Issues · basic check" : "Checking issues…"}</span>
          <button className="autofix-button" onClick={() => void checkWithManic()} disabled={!active || checkingEngine}>{checkingEngine ? "Checking…" : "Check with Manic"}</button>
          <button className="autofix-button" onClick={autoFix} disabled={!active || languageState !== "ready"}>Auto-fix</button>
          <span className="autosave-label">Autosave on</span>
        </div>
      </header>
      {message && <div className="notice error">{message}</div>}
      {engineCheck && <section className={engineCheck.ok ? "engine-check-panel ok" : "engine-check-panel error"} aria-label="Full Manic check output">
        <div>
          <strong>{engineCheck.ok ? "Manic check passed" : `Manic check failed · exit ${engineCheck.exitCode ?? "unknown"}`}</strong>
          <span className="engine-check-actions">
            {!engineCheck.ok && workspaceMode !== "source" && <button onClick={() => setWorkspaceMode("source")}>Open source</button>}
            <button onClick={() => setEngineCheck(null)}>Close</button>
          </span>
        </div>
        <pre>{engineCheck.output || (engineCheck.ok ? "No issues found." : "Manic did not provide error output.")}</pre>
      </section>}
      {workspaceMode === "canvas" && active ? <VisualCanvas key={active.path} token={token} fileName={active.path} source={active.content} onApply={editFile} onOpenSource={() => setWorkspaceMode("source")} onRevealSource={revealSourceOffset} onPreview={() => void previewFile()} /> :
      <div className="editor-shell">
        <aside className="file-tree">
          <div className="tree-heading"><strong>Files</strong><span><button onClick={() => void createFile()}>New</button><button onClick={() => void refreshFiles()}>Refresh</button></span></div>
          {loading ? <p>Loading…</p> : files.length === 0 ? <p>No .manic files found.</p> : files.map((file) => (
            <button key={file.path} className={activePath === file.path ? "file-item active" : "file-item"} onClick={() => void openFile(file.path)} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ path: file.path, x: event.clientX, y: event.clientY }); }} title={`${file.path} · right-click for actions`}>
              <span className="file-dot" /> <span>{file.path}</span>
            </button>
          ))}
        </aside>
        <section className="editor-area">
          <div className="file-toolbar">
            <button className="primary-action" onClick={() => void previewFile()} disabled={!active || checkingEngine}>{checkingEngine ? "Checking…" : "▶ Preview"}</button>
            <button className="primary-action" onClick={chooseRender} disabled={!active}>● Render</button>
            <span className="toolbar-divider" />
            <button onClick={() => void createFile()}>New</button>
            <button onClick={() => void renameFile(activePath)} disabled={!active}>Rename <kbd>F2</kbd></button>
            <button onClick={() => void duplicateFile(activePath)} disabled={!active}>Duplicate</button>
            <button onClick={() => void saveAs()} disabled={!active}>Save As</button>
            <button className="danger" onClick={() => void deleteFile(activePath)} disabled={!active}>Move to Trash</button>
          </div>
          <div className="tab-strip">
            {tabs.map((tab) => <button key={tab.path} className={activePath === tab.path ? "editor-tab active" : "editor-tab"} onClick={() => setActivePath(tab.path)}>
              <span>{tab.name}</span>{tab.saveState !== "clean" && <i className={`save-state ${tab.saveState}`} title={tab.saveState} />}
              <b onClick={(event) => { event.stopPropagation(); closeFile(tab.path); }} aria-label={`Close ${tab.name}`}>×</b>
            </button>)}
          </div>
          {active ? <>
            {active.saveState === "conflict" && <div className="conflict-bar"><span>{active.message} Your local edits are still open.</span><button onClick={() => void reloadFile(active.path)}>Discard edits and reload</button></div>}
            {active.saveState === "error" && <div className="conflict-bar error"><span>{active.message}</span><button onClick={() => void saveFile(active.path)}>Try again</button></div>}
            <div className="monaco-wrap">
              <Editor
                path={`file:///${active.path}`}
                language="manic"
                theme="manic-dark"
                value={active.content}
                onChange={(value) => editFile(value ?? "")}
                onMount={(editor) => { editorRef.current = editor; setEditorMounted(true); }}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontSize: 14,
                  lineHeight: 22,
                  fontLigatures: true,
                  padding: { top: 16, bottom: 12 },
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  tabSize: 2,
                  smoothScrolling: true,
                  cursorBlinking: "smooth",
                  cursorSmoothCaretAnimation: "on",
                  renderLineHighlight: "all",
                  bracketPairColorization: { enabled: true },
                  guides: { bracketPairs: "active", indentation: true },
                  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
                  quickSuggestions: { other: "on", comments: "off", strings: "on" },
                  quickSuggestionsDelay: 10,
                  suggestOnTriggerCharacters: true,
                  wordBasedSuggestions: "off",
                  "semanticHighlighting.enabled": true,
                }}
              />
            </div>
            {diagnostics.length > 0 && <section className="diagnostics-panel" aria-label="Manic problems">
              <div className="diagnostics-heading">
                <strong>{diagnostics.length} {diagnostics.length === 1 ? "problem" : "problems"}</strong>
                <span>Click a problem to jump to its source.</span>
              </div>
              <div className="diagnostics-list">
                {diagnostics.map((diagnostic, index) => <button
                  key={`${diagnostic.start}-${diagnostic.len}-${index}`}
                  className={`diagnostic-item ${diagnostic.severity}`}
                  onClick={() => revealDiagnostic(diagnostic)}
                >
                  <span className="diagnostic-severity">{diagnostic.severity === "warning" ? "Warning" : "Error"}</span>
                  <strong>Ln {diagnostic.line}, Col {diagnostic.column}</strong>
                  <span className="diagnostic-message">{diagnostic.message}</span>
                </button>)}
              </div>
            </section>}
            <div className="editor-status"><span>{active.path}</span><span>{active.message || statusText(active.saveState)}</span></div>
          </> : <div className="empty-editor"><strong>Choose a Manic file</strong><p>Your open files will appear as tabs.</p></div>}
        </section>
      </div>
      }
      {contextMenu && <div className="file-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        <strong>{contextMenu.path}</strong>
        <button onClick={() => { setContextMenu(null); void openFile(contextMenu.path); }}>Open</button>
        <button onClick={() => { setContextMenu(null); void renameFile(contextMenu.path); }}>Rename</button>
        <button onClick={() => { setContextMenu(null); void duplicateFile(contextMenu.path); }}>Duplicate</button>
        <button className="danger" onClick={() => { setContextMenu(null); void deleteFile(contextMenu.path); }}>Move to Trash</button>
      </div>}
      {renderOpen && <div className="render-backdrop" onMouseDown={() => setRenderOpen(false)}>
        <section className="render-dialog" onMouseDown={(event) => event.stopPropagation()} aria-label="Render Manic file">
          <header><div><span className="eyebrow">MANIC RENDER</span><h2>{active?.name ?? "Story"}</h2><p>Choose the delivery format. Manic remains the rendering and licensing authority.</p></div><button className="dialog-close" onClick={() => setRenderOpen(false)}>×</button></header>
          <div className="render-layout">
            <div className="render-controls">
              <label className="field"><span>Format</span><select value={renderOptions.format} onChange={(event) => setRenderOptions({ ...renderOptions, format: event.target.value as RenderFormat })}><option value="mp4">MP4 video</option><option value="gif">Animated GIF</option><option value="png">PNG frame sequence</option></select></label>
              <label className="field"><span>FPS</span><input type="number" min="1" max="240" value={renderOptions.fps} onChange={(event) => setRenderOptions({ ...renderOptions, fps: Number(event.target.value) })} /></label>
              <label className="field"><span>Scale</span><input type="number" min="0.1" max="8" step="0.1" value={renderOptions.scale} onChange={(event) => setRenderOptions({ ...renderOptions, scale: Number(event.target.value) })} /></label>
              <label className="field"><span>Canvas</span><select value={renderOptions.canvas} onChange={(event) => setRenderOptions({ ...renderOptions, canvas: event.target.value as RenderOptions["canvas"] })}><option value="auto">Use story</option><option value="portrait">Portrait</option><option value="feed">Feed</option><option value="square">Square</option><option value="landscape">Landscape</option></select></label>
              <label className="render-check"><input type="checkbox" checked={renderOptions.branded} onChange={(event) => setRenderOptions({ ...renderOptions, branded: event.target.checked })} /><span>Include Manic branding</span></label>
              <label className="render-check"><input type="checkbox" checked={renderOptions.cpuShaders} onChange={(event) => setRenderOptions({ ...renderOptions, cpuShaders: event.target.checked })} /><span>CPU shaders</span></label>
              <div className="render-buttons"><button className="save-button" onClick={() => void startRender()} disabled={renderJob?.status === "running"}>Render {renderOptions.format.toUpperCase()}</button>{renderJob?.status === "running" && <button className="cancel-button" onClick={() => void cancelRender()}>Cancel</button>}</div>
              <section className="render-history"><div><strong>Render history</strong><button onClick={() => void loadRenderHistory()}>Refresh</button></div>{renderHistory.length === 0 ? <p>No renders in this project yet.</p> : renderHistory.slice(0, 12).map((job) => <button key={job.id} className={renderJob?.id === job.id ? "history-item active" : "history-item"} onClick={() => void selectRender(job)}><span>{job.file.split("/").at(-1)}</span><small>{job.format.toUpperCase()} · {job.status} · {formatElapsed(job.progress.elapsedMs)}</small></button>)}</section>
            </div>
            <div className="render-result">
              {!renderJob && <div className="render-empty"><strong>Your result appears here.</strong><span>MP4 opens with video controls. GIF and PNG appear as images.</span></div>}
              {renderJob && <><div className={`render-state ${renderJob.status}`}><strong>{renderJob.status === "completed" ? "Render ready" : renderJob.progress.phase === "encoding" ? "Encoding…" : renderJob.status === "running" ? "Rendering…" : renderJob.status}</strong><span>{renderJob.outputName ?? (renderJob.format === "png" && renderJob.frameCount ? `${renderJob.frameCount} frames` : `${formatElapsed(renderJob.progress.elapsedMs)} elapsed`)}</span></div>
                <div className="render-progress"><i style={{ width: `${renderJob.progress.percent ?? 0}%` }} /><span>{renderJob.progress.percent === null ? renderJob.progress.phase : `${Math.round(renderJob.progress.percent)}%`}{renderJob.progress.framesRendered !== null && renderJob.progress.totalFrames !== null ? ` · ${renderJob.progress.framesRendered}/${renderJob.progress.totalFrames} frames` : ""}</span></div>
                {renderMedia && renderJob.format === "mp4" && <video className="render-player" src={renderMedia} controls playsInline />}
                {renderMedia && renderJob.format !== "mp4" && <img className="render-player" src={renderMedia} alt={`${renderJob.format.toUpperCase()} render output`} />}
                {renderMedia && <a className="download-output" href={renderMedia} download={renderJob.outputName ?? `manic-render.${renderJob.format === "png" ? "png" : renderJob.format}`}>Download {renderJob.format === "png" ? "first frame" : renderJob.format.toUpperCase()}</a>}
                <pre className="render-log">{renderJob.log}</pre></>}
            </div>
          </div>
        </section>
      </div>}
    </div>
  );
}

function normalizedPromptPath(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed) return "";
  return trimmed.toLowerCase().endsWith(".manic") ? trimmed : `${trimmed}.manic`;
}

function suggestedCopyPath(path: string): string {
  return path.replace(/\.manic$/iu, "-copy.manic");
}

function escapeManicString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function withoutContent(file: WorkspaceFile): WorkspaceFileSummary {
  const { content: _content, ...summary } = file;
  return summary;
}

function statusText(state: SaveState): string {
  if (state === "dirty") return "Waiting to save";
  if (state === "saving") return "Saving…";
  if (state === "saved") return "Saved";
  if (state === "conflict") return "External change detected";
  if (state === "error") return "Save failed";
  return "Saved";
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
