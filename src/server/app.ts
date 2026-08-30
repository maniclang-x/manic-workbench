import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { ManicAssetKind, ManicSmartDrawImportMetadata, ManicSmartDrawInspection } from "@maniclang/scene";
import type { Diagnostics } from "./diagnostics.js";
import { normalizeAiBaseUrl, type SettingsStore, type WorkbenchSettings } from "./settings.js";
import { RenderJobManager } from "./renderJobs.js";
import { runEngineCheck } from "./engineCheck.js";
import { createAiSecretStore, type AiSecretStore } from "./aiSecrets.js";
import { AgentRunManager } from "./agentRuns.js";
import { createCandidateFixer, type CandidateFixer } from "./candidateFix.js";
import { getEngineInstallPlan, installManicEngine, type EngineInstallMethod } from "./engineInstall.js";
import { AnthropicProvider, OpenAiCompatibleProvider, OpenAiProvider, type AgentRunInput, type EngineChecker, type ModelProvider, type ThreadTarget } from "./manicAgent.js";
import {
  appendTurn, buildConversation, createThread, getThread, listThreads, recordApply, removeThread, ThreadNotFoundError,
} from "./agentThreads.js";
import { createPromptStore, type PromptStore } from "./promptStore.js";
import {
  exportProjectSmartDraw, importProjectAsset, importProjectSmartDraw, renameProjectSmartDraw, resolveAsset,
  searchAssets, trashProjectSmartDraw,
} from "./assets.js";
import {
  requireSmartDrawInspection, requireSmartDrawSuggestion, runSmartDrawEngine, type SmartDrawEngineRunner,
} from "./smartDraw.js";
import {
  createManicFile, duplicateManicFile, listManicFiles, readManicFile, renameManicFile,
  resolveExistingManicFile, resolveWorkspace, saveManicFile, trashManicFile, WorkspaceConflictError,
} from "./workspace.js";

export interface WorkbenchContext {
  token: string;
  workspace: string;
  clientRoot: string;
  version: string;
  settingsStore: SettingsStore;
  diagnostics(settings: WorkbenchSettings): Promise<Diagnostics>;
  pickWorkspace?(currentWorkspace: string): Promise<string | null>;
  engineOverride?: string;
  aiSecrets?: AiSecretStore;
  promptStore?: PromptStore;
  /** Test seam for preview, manual, and agent-run validation; defaults to the installed engine. */
  engineCheck?: EngineChecker;
  /** Test seam for engine-owned Smart Draw inspection and manifest authoring. */
  smartDrawRunner?: SmartDrawEngineRunner;
  /** Host boundary for a checked native preview; defaults to RenderJobManager launching Manic. */
  launchPreview?(workspace: string, file: string, settings: WorkbenchSettings): Promise<void>;
  /** Test seam for the local candidate autofix; defaults to engine `manic fix` with WASM fallback. */
  candidateAutofix?: CandidateFixer;
  openAiProvider?(apiKey: string, model: string, reasoning: WorkbenchSettings["ai"]["reasoning"]): ModelProvider;
  openAiCompatibleProvider?(baseUrl: string, apiKey: string, model: string): ModelProvider;
  anthropicProvider?(apiKey: string, model: string, reasoning: WorkbenchSettings["ai"]["reasoning"]): ModelProvider;
}

export function createApp(context: WorkbenchContext): Hono {
  const app = new Hono();
  let workspace = context.workspace;
  const renders = new RenderJobManager(context.engineOverride);
  const agentRuns = new AgentRunManager();
  const aiSecrets = context.aiSecrets ?? createAiSecretStore();
  const promptStore = context.promptStore ?? createPromptStore();
  const candidateFixer = context.candidateAutofix ?? createCandidateFixer(context.clientRoot);
  const engineCheck = context.engineCheck ?? runEngineCheck;
  const smartDrawRunner = context.smartDrawRunner ?? runSmartDrawEngine;

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  });

  app.get("/health", (c) => c.json({ status: "ok", service: "manic-workbench" }));

  app.use("/api/*", async (c, next) => {
    const requestOrigin = c.req.header("Origin");
    const listenerOrigin = new URL(c.req.url).origin;
    if (requestOrigin && requestOrigin !== listenerOrigin) {
      return c.json({ error: "The request origin is not allowed." }, 403);
    }
    if (c.req.header("X-Manic-Session") !== context.token) {
      return c.json({ error: "This Workbench session is not authorized." }, 401);
    }
    await next();
  });

  app.get("/api/bootstrap", async (c) => {
    const settings = await context.settingsStore.load();
    const diagnostics = await context.diagnostics(settings);
    return c.json({
      workbench: { version: context.version },
      workspace,
      settings,
      settingsPath: context.settingsStore.path,
      diagnostics,
      ai: aiSecrets.status(),
    });
  });

  app.post("/api/workspace/pick", async (c) => {
    if (!context.pickWorkspace) return c.json({ error: "The native folder picker is unavailable." }, 501);
    try {
      const selected = await context.pickWorkspace(workspace);
      if (!selected) return c.json({ workspace, cancelled: true });
      workspace = await resolveWorkspace(selected);
      return c.json({ workspace, cancelled: false });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Project folder could not be opened." }, 400);
    }
  });

  app.put("/api/settings", async (c) => {
    try {
      const body: unknown = await c.req.json();
      const settings = await context.settingsStore.save(body);
      const diagnostics = await context.diagnostics(settings);
      return c.json({ settings, diagnostics });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid settings." }, 400);
    }
  });

  app.get("/api/engine/install", async (c) => {
    try {
      const settings = await context.settingsStore.load();
      return c.json({ plan: await getEngineInstallPlan(settings.updateChannel) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Install options are unavailable." }, 400);
    }
  });

  app.post("/api/engine/install", async (c) => {
    try {
      const settings = await context.settingsStore.load();
      const body = await c.req.json<{ method?: unknown }>();
      const method = body.method === "brew" || body.method === "script" ? body.method as EngineInstallMethod : "script";
      const result = await installManicEngine({
        method,
        channel: settings.updateChannel,
        currentEnginePath: settings.enginePath,
      });
      let nextSettings = settings;
      if (result.suggestedEnginePath && !settings.enginePath.trim()) {
        nextSettings = await context.settingsStore.save({ ...settings, enginePath: result.suggestedEnginePath });
      }
      const diagnostics = await context.diagnostics(nextSettings);
      return c.json({
        result: { ...result, ok: result.ok || diagnostics.engine.available },
        settings: nextSettings,
        diagnostics,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Manic could not be installed." }, 400);
    }
  });

  app.get("/api/ai/status", (c) => c.json({ secrets: aiSecrets.status() }));

  app.put("/api/ai/key", async (c) => {
    try {
      const body = await c.req.json<{ key?: unknown; value?: unknown; apiKey?: unknown }>();
      // Backward-compatible: { apiKey } still sets OPENAI_API_KEY.
      const key = typeof body.key === "string" && body.key.trim()
        ? body.key
        : typeof body.apiKey === "string"
          ? "OPENAI_API_KEY"
          : "";
      if (!key) throw new Error("key must be a string.");
      const value = typeof body.value === "string"
        ? body.value
        : typeof body.apiKey === "string"
          ? body.apiKey
          : "";
      if (typeof value !== "string") throw new Error("value must be a string.");
      if (value.trim()) aiSecrets.set(key, value);
      else aiSecrets.clear(key);
      return c.json({ secrets: aiSecrets.status() });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "API key could not be configured." }, 400);
    }
  });

  app.post("/api/ai/run", async (c) => {
    try {
      const settings = await context.settingsStore.load();
      const body = await c.req.json<AgentRunInput>();
      const effective = applyRunOverride(settings, body);
      if (effective.ai.provider === "none") throw new Error("Enable an AI provider in Workbench settings first.");
      const provider = resolveProvider(effective, aiSecrets, context);
      const prompt = await promptStore.get();

      // A thread turn resolves its target and steering context from the
      // thread record; the client supplies only the message and images.
      let input = body;
      let conversation = "";
      const threadId = typeof body.threadId === "string" ? body.threadId : "";
      if (threadId) {
        const thread = await getThread(workspace, threadId);
        const targetPath = thread.target.kind === "file" ? thread.target.path : thread.target.draftName;
        const existing = await readManicFile(workspace, targetPath).catch(() => null);
        conversation = buildConversation(thread, existing?.version ?? null);
        input = existing
          ? { ...body, path: existing.path, newPath: "", intent: body.intent === "diagnose" ? "diagnose" : "refine" }
          : { ...body, path: "", newPath: targetPath, intent: "create" };
      }

      const run = agentRuns.start({
        workspace,
        settings,
        engineOverride: context.engineOverride,
        prompt,
        provider,
        input,
        conversation,
        check: context.engineCheck,
        autofix: (content, signal) => candidateFixer({
          workspace,
          content,
          settings: effective,
          engineOverride: context.engineOverride,
          signal,
        }),
        onFinished: threadId
          ? async (result) => {
              await appendTurn(workspace, threadId, {
                runId: result.id,
                userMessage: typeof body.message === "string" ? body.message : "",
                proposalSummary: result.message,
                status: result.status,
                appliedRevision: null,
                at: Date.now(),
              });
            }
          : undefined,
      });
      return c.json({ run }, 202);
    } catch (error) {
      const status = error instanceof ThreadNotFoundError ? 404 : 400;
      return c.json({ error: error instanceof Error ? error.message : "The Manic AI run failed." }, status);
    }
  });

  app.get("/api/ai/threads", async (c) => {
    try {
      return c.json({ threads: await listThreads(workspace) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Authorship threads are unavailable." }, 400);
    }
  });

  app.post("/api/ai/threads", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown; draftName?: unknown }>();
      let target: ThreadTarget;
      if (typeof body.path === "string" && body.path) {
        target = { kind: "file", path: (await resolveExistingManicFile(workspace, body.path)).path };
      } else if (typeof body.draftName === "string" && body.draftName) {
        target = { kind: "draft", draftName: body.draftName };
      } else {
        throw new Error("A thread needs an existing Manic file path or a new draft name.");
      }
      return c.json({ thread: await createThread(workspace, target) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The thread could not be created." }, 400);
    }
  });

  app.get("/api/ai/threads/:id", async (c) => {
    try {
      return c.json({ thread: await getThread(workspace, c.req.param("id")) });
    } catch (error) {
      const status = error instanceof ThreadNotFoundError ? 404 : 400;
      return c.json({ error: error instanceof Error ? error.message : "The thread could not be read." }, status);
    }
  });

  app.delete("/api/ai/threads/:id", async (c) => {
    try {
      await removeThread(workspace, c.req.param("id"));
      return c.json({ removed: true });
    } catch (error) {
      const status = error instanceof ThreadNotFoundError ? 404 : 400;
      return c.json({ error: error instanceof Error ? error.message : "The thread could not be removed." }, status);
    }
  });

  app.post("/api/ai/threads/:id/apply", async (c) => {
    try {
      const threadId = c.req.param("id");
      const body = await c.req.json<{ runId?: unknown }>();
      if (typeof body.runId !== "string" || !body.runId) throw new Error("runId is required.");
      await getThread(workspace, threadId);
      const run = agentRuns.get(body.runId);
      if (!run || run.status !== "ready" || !run.proposal) throw new Error("Only a Manic-validated proposal can be applied.");
      const proposal = run.proposal;
      let file;
      if (proposal.operation === "create") {
        file = await createManicFile(workspace, proposal.path, proposal.content);
      } else {
        if (!proposal.basedOnRevision) throw new Error("The proposal has no source revision.");
        file = await saveManicFile(workspace, proposal.path, proposal.content, proposal.basedOnRevision);
      }
      const thread = await recordApply(workspace, threadId, run.id, file.path, file.version);
      return c.json({ file, thread });
    } catch (error) {
      const status = error instanceof ThreadNotFoundError
        ? 404
        : error instanceof WorkspaceConflictError ? 409 : 400;
      return c.json({ error: error instanceof Error ? error.message : "The proposal could not be applied." }, status);
    }
  });

  app.get("/api/ai/run/:id", (c) => {
    const run = agentRuns.get(c.req.param("id"));
    if (!run) return c.json({ error: "That AI run was not found." }, 404);
    return c.json({ run });
  });

  app.delete("/api/ai/run/:id", (c) => {
    try {
      return c.json({ run: agentRuns.cancel(c.req.param("id")) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The AI run could not be cancelled." }, 404);
    }
  });

  app.get("/api/files", async (c) => {
    try {
      return c.json({ files: await listManicFiles(workspace) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Files could not be listed." }, 400);
    }
  });

  app.get("/api/assets", async (c) => {
    try {
      const scope = c.req.query("scope") === "project" ? "project" : "library";
      const kind = parseAssetKind(c.req.query("kind"));
      const settings = await context.settingsStore.load();
      return c.json(await searchAssets(workspace, settings, {
        scope,
        kind,
        query: c.req.query("query") ?? "",
        cursor: c.req.query("cursor") ?? null,
        limit: Number(c.req.query("limit") ?? 48),
      }, context.engineOverride));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Assets could not be listed." }, 400);
    }
  });

  app.get("/api/assets/resolve", async (c) => {
    try {
      const settings = await context.settingsStore.load();
      const resolved = await resolveAsset(workspace, settings, c.req.query("uri") ?? "", context.engineOverride);
      return c.json({ asset: resolved.asset });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The asset could not be resolved." }, 404);
    }
  });

  app.get("/api/assets/content", async (c) => {
    try {
      const settings = await context.settingsStore.load();
      const resolved = await resolveAsset(workspace, settings, c.req.query("uri") ?? "", context.engineOverride);
      const size = (await stat(resolved.path)).size;
      const stream = createReadStream(resolved.path);
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        headers: {
          "Content-Type": resolved.asset.mediaType,
          "Content-Length": String(size),
          "Content-Disposition": "inline",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The asset content is unavailable." }, 404);
    }
  });

  app.post("/api/assets/import", async (c) => {
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("Choose a PNG, JPEG, or SVG file to upload.");
      return c.json({ asset: await importProjectAsset(workspace, file) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The asset could not be imported." }, 400);
    }
  });

  app.post("/api/assets/smartdraw/import", async (c) => {
    try {
      const form = await c.req.formData();
      const source = form.get("source"), guideValue = form.get("guide");
      if (!(source instanceof File)) throw new Error("Choose SVG artwork, or PNG artwork with an SVG reveal guide.");
      const guide = guideValue instanceof File && guideValue.size > 0 ? guideValue : null;
      const metadata = smartDrawImportMetadata(form);
      const settings = await context.settingsStore.load();
      let inspection: ManicSmartDrawInspection | null = null;
      let prepared = false;
      const asset = await importProjectSmartDraw(workspace, source, guide, async (sourcePath, guidePath) => {
        prepared = true;
        const arguments_ = ["smartdraw", "init", sourcePath];
        if (guidePath) arguments_.push("--guide", guidePath);
        await smartDrawRunner(workspace, arguments_, settings, context.engineOverride);
        inspection = requireSmartDrawInspection(await smartDrawRunner(
          workspace, ["smartdraw", "inspect", sourcePath, "--json"], settings, context.engineOverride,
        ));
      }, metadata);
      if (!inspection) {
        const resolved = await resolveProjectSmartDraw(workspace, settings, asset.uri, context.engineOverride);
        inspection = requireSmartDrawInspection(await smartDrawRunner(
          workspace, ["smartdraw", "inspect", resolved.path, "--json"], settings, context.engineOverride,
        ));
      }
      return c.json({ asset, inspection, duplicate: !prepared }, prepared ? 201 : 200);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The Smart Draw package could not be imported." }, 400);
    }
  });

  app.get("/api/assets/smartdraw/inspect", async (c) => {
    try {
      const settings = await context.settingsStore.load();
      const resolved = await resolveProjectSmartDraw(workspace, settings, c.req.query("uri") ?? "", context.engineOverride);
      return c.json(requireSmartDrawInspection(await smartDrawRunner(
        workspace, ["smartdraw", "inspect", resolved.path, "--json"], settings, context.engineOverride,
      )));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The Smart Draw package could not be inspected." }, 400);
    }
  });

  app.post("/api/assets/smartdraw/suggest", async (c) => {
    try {
      const body = await c.req.json<{ uri?: unknown; write?: unknown }>();
      if (typeof body.uri !== "string" || typeof body.write !== "boolean") throw new Error("uri and write are required.");
      const settings = await context.settingsStore.load();
      const resolved = await resolveProjectSmartDraw(workspace, settings, body.uri, context.engineOverride);
      const arguments_ = ["smartdraw", "suggest", resolved.path, "--json"];
      if (body.write) arguments_.push("--write", "--force");
      const suggestion = requireSmartDrawSuggestion(await smartDrawRunner(workspace, arguments_, settings, context.engineOverride));
      if (!body.write) return c.json({ suggestion });
      const inspection = requireSmartDrawInspection(await smartDrawRunner(
        workspace, ["smartdraw", "inspect", resolved.path, "--json"], settings, context.engineOverride,
      ));
      return c.json({ suggestion, inspection });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Smart Draw ordering could not be suggested." }, 400);
    }
  });

  app.post("/api/assets/smartdraw/reverse", async (c) => {
    try {
      const body = await c.req.json<{ uri?: unknown; pathIndex?: unknown; reversed?: unknown }>();
      if (typeof body.uri !== "string" || !Number.isSafeInteger(body.pathIndex) || Number(body.pathIndex) < 0 || typeof body.reversed !== "boolean") {
        throw new Error("uri, a non-negative pathIndex, and reversed are required.");
      }
      const settings = await context.settingsStore.load();
      const resolved = await resolveProjectSmartDraw(workspace, settings, body.uri, context.engineOverride);
      return c.json(requireSmartDrawInspection(await smartDrawRunner(workspace, [
        "smartdraw", "reverse", resolved.path, String(body.pathIndex), "--set", body.reversed ? "reverse" : "source", "--json",
      ], settings, context.engineOverride)));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Smart Draw path direction could not be changed." }, 400);
    }
  });

  app.post("/api/assets/smartdraw/save", async (c) => {
    try {
      const body = await c.req.json<{ uri?: unknown; order?: unknown; reverse?: unknown }>();
      if (typeof body.uri !== "string" || !isPathIndexList(body.order, false) || !isPathIndexList(body.reverse, true)) {
        throw new Error("uri, a complete order, and a reverse path list are required.");
      }
      const settings = await context.settingsStore.load();
      const resolved = await resolveProjectSmartDraw(workspace, settings, body.uri, context.engineOverride);
      const arguments_ = ["smartdraw", "apply", resolved.path, "--order", body.order.join(",")];
      if (body.reverse.length) arguments_.push("--reverse", body.reverse.join(","));
      arguments_.push("--json");
      return c.json(requireSmartDrawInspection(await smartDrawRunner(
        workspace, arguments_, settings, context.engineOverride,
      )));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Smart Draw choreography could not be saved." }, 400);
    }
  });

  app.post("/api/assets/smartdraw/rename", async (c) => {
    try {
      const body = await c.req.json<{ uri?: unknown; title?: unknown }>();
      if (typeof body.uri !== "string" || typeof body.title !== "string") throw new Error("uri and title are required.");
      return c.json({ asset: await renameProjectSmartDraw(workspace, body.uri, body.title) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The Smart Draw package could not be renamed." }, 400);
    }
  });

  app.delete("/api/assets/smartdraw", async (c) => {
    try {
      const body = await c.req.json<{ uri?: unknown }>();
      if (typeof body.uri !== "string") throw new Error("uri is required.");
      return c.json({ asset: await trashProjectSmartDraw(workspace, body.uri), recoverable: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The Smart Draw package could not be moved to trash." }, 400);
    }
  });

  app.get("/api/assets/smartdraw/export", async (c) => {
    try {
      const exported = await exportProjectSmartDraw(workspace, c.req.query("uri") ?? "");
      return new Response(new Uint8Array(exported.bytes), {
        headers: {
          "Content-Type": exported.mediaType,
          "Content-Length": String(exported.bytes.length),
          "Content-Disposition": `attachment; filename="${exported.filename}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The Smart Draw package could not be exported." }, 400);
    }
  });

  app.get("/api/file", async (c) => {
    try {
      return c.json({ file: await readManicFile(workspace, c.req.query("path") ?? "") });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "File could not be read." }, 400);
    }
  });

  app.put("/api/file", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown; content?: unknown; expectedVersion?: unknown }>();
      if (typeof body.path !== "string" || typeof body.content !== "string" || typeof body.expectedVersion !== "string") {
        throw new Error("path, content, and expectedVersion are required.");
      }
      return c.json({ file: await saveManicFile(workspace, body.path, body.content, body.expectedVersion) });
    } catch (error) {
      const status = error instanceof WorkspaceConflictError ? 409 : 400;
      return c.json({ error: error instanceof Error ? error.message : "File could not be saved." }, status);
    }
  });

  app.post("/api/file", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown; content?: unknown }>();
      if (typeof body.path !== "string" || typeof body.content !== "string") throw new Error("path and content are required.");
      return c.json({ file: await createManicFile(workspace, body.path, body.content) }, 201);
    } catch (error) {
      const status = error instanceof WorkspaceConflictError ? 409 : 400;
      return c.json({ error: error instanceof Error ? error.message : "File could not be created." }, status);
    }
  });

  app.post("/api/file/rename", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown; newPath?: unknown; expectedVersion?: unknown }>();
      if (typeof body.path !== "string" || typeof body.newPath !== "string" || typeof body.expectedVersion !== "string") {
        throw new Error("path, newPath, and expectedVersion are required.");
      }
      return c.json({ file: await renameManicFile(workspace, body.path, body.newPath, body.expectedVersion) });
    } catch (error) {
      const status = error instanceof WorkspaceConflictError ? 409 : 400;
      return c.json({ error: error instanceof Error ? error.message : "File could not be renamed." }, status);
    }
  });

  app.post("/api/file/duplicate", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown; newPath?: unknown; expectedVersion?: unknown; content?: unknown }>();
      if (typeof body.path !== "string" || typeof body.newPath !== "string" || typeof body.expectedVersion !== "string") {
        throw new Error("path, newPath, and expectedVersion are required.");
      }
      if (body.content !== undefined && typeof body.content !== "string") throw new Error("content must be text.");
      return c.json({ file: await duplicateManicFile(workspace, body.path, body.newPath, body.expectedVersion, body.content) }, 201);
    } catch (error) {
      const status = error instanceof WorkspaceConflictError ? 409 : 400;
      return c.json({ error: error instanceof Error ? error.message : "File could not be duplicated." }, status);
    }
  });

  app.delete("/api/file", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown; expectedVersion?: unknown }>();
      if (typeof body.path !== "string" || typeof body.expectedVersion !== "string") throw new Error("path and expectedVersion are required.");
      return c.json(await trashManicFile(workspace, body.path, body.expectedVersion));
    } catch (error) {
      const status = error instanceof WorkspaceConflictError ? 409 : 400;
      return c.json({ error: error instanceof Error ? error.message : "File could not be moved to trash." }, status);
    }
  });

  app.post("/api/preview", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown }>();
      if (typeof body.path !== "string") throw new Error("path is required.");
      const file = await resolveExistingManicFile(workspace, body.path);
      const settings = await context.settingsStore.load();
      const check = await engineCheck(workspace, file.absolute, settings, context.engineOverride);
      if (!check.ok) return c.json({ started: false, path: file.path, check });
      if (context.launchPreview) await context.launchPreview(workspace, file.absolute, settings);
      else await renders.launchPreview(workspace, file.absolute, settings);
      return c.json({ started: true, path: file.path, check });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Preview could not be started." }, 400);
    }
  });

  app.post("/api/check", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown }>();
      if (typeof body.path !== "string") throw new Error("path is required.");
      const file = await resolveExistingManicFile(workspace, body.path);
      const settings = await context.settingsStore.load();
      return c.json(await engineCheck(workspace, file.absolute, settings, context.engineOverride));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Manic check could not be run." }, 400);
    }
  });

  app.post("/api/render", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown; options?: unknown }>();
      if (typeof body.path !== "string") throw new Error("path is required.");
      const file = await resolveExistingManicFile(workspace, body.path);
      const settings = await context.settingsStore.load();
      return c.json({ job: await renders.start(workspace, file.absolute, file.path, settings, body.options) }, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Render could not be started." }, 400);
    }
  });

  app.get("/api/renders", async (c) => {
    try { return c.json({ jobs: await renders.history(workspace) }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "Render history is unavailable." }, 400); }
  });

  app.get("/api/render/:id", async (c) => {
    try { return c.json({ job: await renders.get(workspace, c.req.param("id")) }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "Render was not found." }, 404); }
  });

  app.delete("/api/render/:id", async (c) => {
    try { return c.json({ job: await renders.cancel(workspace, c.req.param("id")) }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "Render was not found." }, 404); }
  });

  app.get("/api/render/:id/output", async (c) => {
    try {
      const output = await renders.output(workspace, c.req.param("id"));
      const mime = output.format === "mp4" ? "video/mp4" : output.format === "gif" ? "image/gif" : "image/png";
      const size = (await stat(output.path)).size;
      const range = parseByteRange(c.req.header("Range"), size);
      const stream = createReadStream(output.path, range ? { start: range.start, end: range.end } : undefined);
      const headers: Record<string, string> = {
        "Content-Type": mime, "Content-Disposition": `inline; filename=\"${output.name}\"`,
        "Cache-Control": "no-store", "Accept-Ranges": "bytes",
        "Content-Length": String(range ? range.end - range.start + 1 : size),
      };
      if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Render output is unavailable." }, 404);
    }
  });

  app.get("*", async (c) => {
    const requested = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
    const absolute = resolve(context.clientRoot, requested);
    const local = relative(context.clientRoot, absolute);
    if (local.startsWith("..") || local.includes("\0")) return c.notFound();
    try {
      const body = await readFile(absolute);
      return new Response(body, {
        headers: { "Content-Type": contentType(absolute) },
      });
    } catch {
      if (extname(requested)) return c.notFound();
      try {
        const body = await readFile(resolve(context.clientRoot, "index.html"));
        return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      } catch {
        return c.notFound();
      }
    }
  });

  app.onError((error, c) => {
    console.error("Workbench request failed:", error);
    return c.json({ error: "Workbench could not complete the request." }, 500);
  });

  return app;
}

async function resolveProjectSmartDraw(workspace: string, settings: WorkbenchSettings, uri: string, engineOverride = "") {
  const resolved = await resolveAsset(workspace, settings, uri, engineOverride);
  if (resolved.asset.scope !== "project" || resolved.asset.kind !== "smartdraw") {
    throw new Error("Choose a project Smart Draw package.");
  }
  return resolved;
}

function smartDrawImportMetadata(form: FormData): ManicSmartDrawImportMetadata {
  const title = formText(form, "title"), author = formText(form, "author"), sourceUrl = formText(form, "sourceUrl");
  const licenseId = formText(form, "licenseId"), licenseName = formText(form, "licenseName");
  const licenseUrl = formText(form, "licenseUrl"), attribution = formText(form, "attribution");
  const hasLicense = Boolean(licenseId || licenseName || licenseUrl || attribution || form.get("attributionRequired") === "true");
  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(hasLicense ? { license: {
      id: licenseId,
      name: licenseName,
      attributionRequired: form.get("attributionRequired") === "true",
      ...(attribution ? { attribution } : {}),
      ...(licenseUrl ? { url: licenseUrl } : {}),
    } } : {}),
  };
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function parseAssetKind(value: string | undefined): ManicAssetKind | "all" {
  return value === "image" || value === "svg" || value === "smartdraw" || value === "model" ? value : "all";
}

function isPathIndexList(value: unknown, allowEmpty: boolean): value is number[] {
  return Array.isArray(value) && value.length <= 40_000 && (allowEmpty || value.length > 0)
    && value.every((index) => Number.isSafeInteger(index) && index >= 0);
}

function applyRunOverride(settings: WorkbenchSettings, body: AgentRunInput): WorkbenchSettings {
  const provider = body.provider;
  const model = body.model;
  const reasoning = body.reasoning;
  const baseUrl = body.baseUrl;
  if (provider === undefined && model === undefined && reasoning === undefined && baseUrl === undefined) return settings;
  if (provider !== undefined && provider !== "openai" && provider !== "anthropic") {
    throw new Error("The run provider must be openai or anthropic.");
  }
  if (model !== undefined && (typeof model !== "string" || !model || model.length > 128 || !/^[A-Za-z0-9._:/-]+$/u.test(model))) {
    throw new Error("Model ids may only use letters, numbers, and . _ : / -");
  }
  if (reasoning !== undefined && !(["none", "low", "medium", "high", "xhigh"] as string[]).includes(reasoning)) {
    throw new Error("Reasoning must be none, low, medium, high, or xhigh.");
  }
  return {
    ...settings,
    ai: {
      ...settings.ai,
      provider: provider ?? settings.ai.provider,
      model: model ?? settings.ai.model,
      reasoning: reasoning ?? settings.ai.reasoning,
      // Explicit "" switches back to the official API; undefined keeps settings.
      baseUrl: baseUrl === undefined ? settings.ai.baseUrl : normalizeAiBaseUrl(baseUrl),
    },
  };
}

function resolveProvider(
  settings: WorkbenchSettings,
  aiSecrets: AiSecretStore,
  context: WorkbenchContext,
): ModelProvider {
  if (settings.ai.provider === "openai") {
    const apiKey = aiSecrets.openAiKey();
    // A custom base URL targets an OpenAI-compatible server (Ollama, LM Studio,
    // vLLM, …) over Chat Completions; local endpoints don't require a key.
    if (settings.ai.baseUrl) {
      return context.openAiCompatibleProvider?.(settings.ai.baseUrl, apiKey, settings.ai.model)
        ?? new OpenAiCompatibleProvider(settings.ai.baseUrl, apiKey, settings.ai.model);
    }
    if (!apiKey) {
      throw new Error(
        "Configure OPENAI_API_KEY in Workbench settings, or set a Base URL for a local"
        + " OpenAI-compatible server (e.g. http://127.0.0.1:11434/v1 for Ollama) — no key needed there.",
      );
    }
    return context.openAiProvider?.(apiKey, settings.ai.model, settings.ai.reasoning)
      ?? new OpenAiProvider(apiKey, settings.ai.model, settings.ai.reasoning);
  }
  if (settings.ai.provider === "anthropic") {
    const apiKey = aiSecrets.anthropicKey();
    if (!apiKey) throw new Error("Configure ANTHROPIC_API_KEY in Workbench settings or the process environment.");
    return context.anthropicProvider?.(apiKey, settings.ai.model, settings.ai.reasoning)
      ?? new AnthropicProvider(apiKey, settings.ai.model, settings.ai.reasoning);
  }
  throw new Error("Enable an AI provider in Workbench settings first.");
}

function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".obj": return "model/obj";
    case ".woff2": return "font/woff2";
    case ".wasm": return "application/wasm";
    default: return "application/octet-stream";
  }
}
