import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createAiSecretStore } from "./aiSecrets.js";
import type { AgentThread, Candidate, ModelProvider, ModelRequest, ModelResult } from "./manicAgent.js";
import { defaultSettings, validateSettings, type SettingsStore, type WorkbenchSettings } from "./settings.js";

const token = "test-session-token";
const origin = "http://127.0.0.1:43127";

describe("Workbench local API boundary", () => {
  it("rejects API requests without the session token", async () => {
    const response = await testApp().request(`${origin}/api/bootstrap`);
    expect(response.status).toBe(401);
  });

  it("rejects a foreign browser origin even with the session token", async () => {
    const response = await testApp().request(`${origin}/api/bootstrap`, {
      headers: { Origin: "https://example.com", "X-Manic-Session": token },
    });
    expect(response.status).toBe(403);
  });

  it("returns only the selected workspace and local diagnostics", async () => {
    const response = await testApp().request(`${origin}/api/bootstrap`, {
      headers: { Origin: origin, "X-Manic-Session": token },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workbench: { version: "0.1.0" },
      workspace: "/safe/project",
      diagnostics: { engine: { available: true }, ffmpeg: { available: false } },
    });
  });

  it("allows only local blob-backed render playback", async () => {
    const response = await testApp().request(`${origin}/health`);
    const policy = response.headers.get("Content-Security-Policy");
    expect(policy).toContain("media-src 'self' blob:");
    expect(policy).toContain("img-src 'self' data: blob:");
  });

  it("validates settings before persisting them", async () => {
    const response = await testApp().request(`${origin}/api/settings`, {
      method: "PUT",
      headers: { Origin: origin, "X-Manic-Session": token, "Content-Type": "application/json" },
      body: JSON.stringify({ ...defaultSettings, preview: { ...defaultSettings.preview, fps: 0 } }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "preview.fps must be between 1 and 240." });
  });

  it("switches the active workspace through the authorized native picker", async () => {
    const selectedWorkspace = await mkdtemp(join(tmpdir(), "manic-workbench-project-"));
    const canonicalWorkspace = await realpath(selectedWorkspace);
    await writeFile(join(selectedWorkspace, "story.manic"), "title(\"Selected project\");\n");
    const app = testApp("/missing/client", async () => selectedWorkspace);
    const switchResponse = await app.request(`${origin}/api/workspace/pick`, {
      method: "POST",
      headers: { Origin: origin, "X-Manic-Session": token },
    });
    expect(switchResponse.status).toBe(200);
    await expect(switchResponse.json()).resolves.toMatchObject({ workspace: canonicalWorkspace, cancelled: false });

    const filesResponse = await app.request(`${origin}/api/files`, {
      headers: { Origin: origin, "X-Manic-Session": token },
    });
    await expect(filesResponse.json()).resolves.toMatchObject({ files: [{ path: "story.manic" }] });
  });

  it("serves root-level client assets with their real content type", async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), "manic-workbench-client-"));
    await writeFile(join(clientRoot, "manic-logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const response = await testApp(clientRoot).request(`${origin}/manic-logo.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("serves bundled WebAssembly with the streaming compilation content type", async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), "manic-workbench-client-"));
    await writeFile(join(clientRoot, "language.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    const response = await testApp(clientRoot).request(`${origin}/language.wasm`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/wasm");
  });

  it("runs the authenticated create, rename, duplicate, and trash workflow", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-workbench-api-files-"));
    const app = testApp("/missing/client", undefined, await realpath(workspace));
    const headers = { Origin: origin, "X-Manic-Session": token, "Content-Type": "application/json" };

    const createdResponse = await app.request(`${origin}/api/file`, {
      method: "POST", headers, body: JSON.stringify({ path: "first.manic", content: "title(\"First\");\n" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json() as { file: { version: string } }).file;

    const renamedResponse = await app.request(`${origin}/api/file/rename`, {
      method: "POST", headers, body: JSON.stringify({ path: "first.manic", newPath: "renamed.manic", expectedVersion: created.version }),
    });
    const renamed = (await renamedResponse.json() as { file: { version: string } }).file;
    expect(renamedResponse.status).toBe(200);

    const duplicateResponse = await app.request(`${origin}/api/file/duplicate`, {
      method: "POST", headers, body: JSON.stringify({ path: "renamed.manic", newPath: "copy.manic", expectedVersion: renamed.version }),
    });
    expect(duplicateResponse.status).toBe(201);

    const trashResponse = await app.request(`${origin}/api/file`, {
      method: "DELETE", headers, body: JSON.stringify({ path: "renamed.manic", expectedVersion: renamed.version }),
    });
    expect(trashResponse.status).toBe(200);
    await expect(trashResponse.json()).resolves.toMatchObject({ path: "renamed.manic" });
  });

});

describe("authorship threads", () => {
  const headers = { Origin: origin, "X-Manic-Session": token, "Content-Type": "application/json" };

  it("guards thread lookup, creation, and apply inputs", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "manic-thread-api-")));
    const { app } = aiTestApp(workspace, []);

    const missingFile = await app.request(`${origin}/api/ai/threads`, {
      method: "POST", headers, body: JSON.stringify({ path: "absent.manic" }),
    });
    expect(missingFile.status).toBe(400);

    const unknown = await app.request(`${origin}/api/ai/threads/thread_${"0".repeat(32)}`, { headers });
    expect(unknown.status).toBe(404);

    const traversal = await app.request(`${origin}/api/ai/threads/${encodeURIComponent("../escape")}`, { headers });
    expect(traversal.status).toBe(404);

    const created = await app.request(`${origin}/api/ai/threads`, {
      method: "POST", headers, body: JSON.stringify({ draftName: "draft.manic" }),
    });
    expect(created.status).toBe(201);
    const { thread } = await created.json() as { thread: AgentThread };

    const badApply = await app.request(`${origin}/api/ai/threads/${thread.threadId}/apply`, {
      method: "POST", headers, body: JSON.stringify({ runId: "agent_nonexistent" }),
    });
    expect(badApply.status).toBe(400);

    const removed = await app.request(`${origin}/api/ai/threads/${thread.threadId}`, { method: "DELETE", headers });
    expect(removed.status).toBe(200);
  });

  it("honors a per-run provider and model override from the chat composer", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "manic-model-override-")));
    const { app, resolved } = aiTestApp(workspace, [
      candidate("create", "a.manic", "ok", 'title("A");\n'),
    ]);

    const badModel = await app.request(`${origin}/api/ai/run`, {
      method: "POST", headers, body: JSON.stringify({ message: "x", intent: "create", path: "", newPath: "a.manic", images: [], model: "bad model!" }),
    });
    expect(badModel.status).toBe(400);

    const badProvider = await app.request(`${origin}/api/ai/run`, {
      method: "POST", headers, body: JSON.stringify({ message: "x", intent: "create", path: "", newPath: "a.manic", images: [], provider: "gemini" }),
    });
    expect(badProvider.status).toBe(400);

    const badReasoning = await app.request(`${origin}/api/ai/run`, {
      method: "POST", headers, body: JSON.stringify({ message: "x", intent: "create", path: "", newPath: "a.manic", images: [], reasoning: "ultra" }),
    });
    expect(badReasoning.status).toBe(400);

    const overridden = await app.request(`${origin}/api/ai/run`, {
      method: "POST", headers, body: JSON.stringify({ message: "make it", intent: "create", path: "", newPath: "a.manic", images: [], provider: "anthropic", model: "claude-opus-5", reasoning: "high" }),
    });
    expect(overridden.status).toBe(202);
    expect(resolved).toEqual([{ provider: "anthropic", model: "claude-opus-5", reasoning: "high" }]);
  });

  it("honors a per-run base URL override before settings are saved, normalizing bare hosts", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "manic-baseurl-override-")));
    const { app, resolved } = aiTestApp(workspace, [
      candidate("create", "a.manic", "ok", 'title("A");\n'),
    ], { withOpenAiKey: false });

    const badUrl = await app.request(`${origin}/api/ai/run`, {
      method: "POST", headers, body: JSON.stringify({ message: "x", intent: "create", path: "", newPath: "a.manic", images: [], baseUrl: "not a url" }),
    });
    expect(badUrl.status).toBe(400);

    const started = await app.request(`${origin}/api/ai/run`, {
      method: "POST", headers, body: JSON.stringify({ message: "make it", intent: "create", path: "", newPath: "a.manic", images: [], model: "gemma3:12b", baseUrl: "127.0.0.1:11434" }),
    });
    expect(started.status).toBe(202);
    expect(resolved).toEqual([{ provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: "gemma3:12b" }]);
  });

  it("routes to the OpenAI-compatible provider when a base URL is set, without requiring a key", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "manic-local-model-")));
    const { app, resolved } = aiTestApp(workspace, [
      candidate("create", "a.manic", "ok", 'title("A");\n'),
    ], { baseUrl: "http://localhost:11434/v1", withOpenAiKey: false });

    const started = await app.request(`${origin}/api/ai/run`, {
      method: "POST", headers, body: JSON.stringify({ message: "make it", intent: "create", path: "", newPath: "a.manic", images: [], model: "qwen2.5-coder:14b" }),
    });
    expect(started.status).toBe(202);
    expect(resolved).toEqual([{ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen2.5-coder:14b" }]);
  });

  it("runs the create-then-refine thread loop with steering context, external-edit marker, and stale-apply conflict", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "manic-thread-flow-")));
    const { app, provider } = aiTestApp(workspace, [
      candidate("create", "story.manic", "Created the rocket story.", 'title("Rocket v1");\n'),
      candidate("replace", "story.manic", "Punchier second stage.", 'title("Rocket v2");\n'),
      candidate("replace", "story.manic", "Slower final camera.", 'title("Rocket v3");\n'),
    ]);

    // Turn 1: create through a draft-bound thread.
    const createdThread = await app.request(`${origin}/api/ai/threads`, {
      method: "POST", headers, body: JSON.stringify({ draftName: "story.manic" }),
    });
    const { thread } = await createdThread.json() as { thread: AgentThread };
    expect(thread.target).toEqual({ kind: "draft", draftName: "story.manic" });

    const firstRun = await runTurn(app, thread.threadId, "create a rocket story");
    expect(provider.requests[0]?.conversation).toBe("");
    expect(provider.requests[0]?.intent).toBe("create");

    const firstThread = await fetchThread(app, thread.threadId);
    expect(firstThread.turns).toHaveLength(1);
    expect(firstThread.turns[0]).toMatchObject({ runId: firstRun.id, status: "ready", appliedRevision: null });

    const firstApply = await app.request(`${origin}/api/ai/threads/${thread.threadId}/apply`, {
      method: "POST", headers, body: JSON.stringify({ runId: firstRun.id }),
    });
    expect(firstApply.status).toBe(200);
    const applied = await firstApply.json() as { file: { path: string; version: string }; thread: AgentThread };
    expect(applied.thread.target).toEqual({ kind: "file", path: "story.manic" });
    expect(applied.thread.lastAppliedRevision).toBe(applied.file.version);

    // Turn 2: the thread supplies compressed history and refines the file on disk.
    const secondRun = await runTurn(app, thread.threadId, "make stage two punchier");
    expect(provider.requests[1]?.intent).toBe("refine");
    expect(provider.requests[1]?.activeDocument?.content).toContain("Rocket v1");
    expect(provider.requests[1]?.conversation).toContain("Created the rocket story.");
    expect(provider.requests[1]?.conversation).not.toContain("edited outside");

    const secondApply = await app.request(`${origin}/api/ai/threads/${thread.threadId}/apply`, {
      method: "POST", headers, body: JSON.stringify({ runId: secondRun.id }),
    });
    expect(secondApply.status).toBe(200);

    // Manual edit outside the thread: the next turn must carry the marker.
    const current = await (await app.request(`${origin}/api/file?path=story.manic`, { headers })).json() as { file: { version: string } };
    const manualEdit = await app.request(`${origin}/api/file`, {
      method: "PUT", headers, body: JSON.stringify({ path: "story.manic", content: 'title("Hand edited");\n', expectedVersion: current.file.version }),
    });
    expect(manualEdit.status).toBe(200);
    const edited = await manualEdit.json() as { file: { version: string } };

    const thirdRun = await runTurn(app, thread.threadId, "slow the final camera move");
    expect(provider.requests[2]?.conversation).toContain("edited outside this conversation");
    expect(provider.requests[2]?.activeDocument?.content).toContain("Hand edited");

    // The file changes again before Apply: applying the stale proposal must conflict.
    await app.request(`${origin}/api/file`, {
      method: "PUT", headers, body: JSON.stringify({ path: "story.manic", content: 'title("Changed again");\n', expectedVersion: edited.file.version }),
    });
    const staleApply = await app.request(`${origin}/api/ai/threads/${thread.threadId}/apply`, {
      method: "POST", headers, body: JSON.stringify({ runId: thirdRun.id }),
    });
    expect(staleApply.status).toBe(409);

    const finalThread = await fetchThread(app, thread.threadId);
    expect(finalThread.turns).toHaveLength(3);
    expect(finalThread.turns[2]?.appliedRevision).toBeNull();
  });

  async function runTurn(app: ReturnType<typeof createApp>, threadId: string, message: string) {
    const started = await app.request(`${origin}/api/ai/run`, {
      method: "POST", headers, body: JSON.stringify({ message, intent: "refine", path: "", newPath: "", images: [], threadId }),
    });
    expect(started.status).toBe(202);
    const { run } = await started.json() as { run: { id: string } };
    let latest: { id: string; status: string } = { id: run.id, status: "running" };
    await vi.waitFor(async () => {
      const polled = await app.request(`${origin}/api/ai/run/${encodeURIComponent(latest.id)}`, { headers });
      latest = ((await polled.json()) as { run: { id: string; status: string } }).run;
      expect(latest.status).toBe("ready");
    }, { timeout: 5_000 });
    return latest;
  }

  async function fetchThread(app: ReturnType<typeof createApp>, threadId: string): Promise<AgentThread> {
    const response = await app.request(`${origin}/api/ai/threads/${threadId}`, { headers });
    expect(response.status).toBe(200);
    return ((await response.json()) as { thread: AgentThread }).thread;
  }
});

class RecordingProvider implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly script: ModelResult[]) {}
  async generate(request: ModelRequest): Promise<ModelResult> {
    const next = this.script[this.requests.length];
    this.requests.push(request);
    if (!next) throw new Error("The test provider has no more scripted responses.");
    return next;
  }
}

function candidate(operation: Candidate["operation"], path: string, message: string, content: string): ModelResult {
  return { candidate: { operation, path, message, content }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
}

function aiTestApp(workspace: string, script: ModelResult[], options: { baseUrl?: string; withOpenAiKey?: boolean } = {}) {
  const provider = new RecordingProvider(script);
  const resolved: Array<{ provider: string; model: string; reasoning?: string; baseUrl?: string; apiKey?: string }> = [];
  const settings: WorkbenchSettings = structuredClone(defaultSettings);
  settings.ai.provider = "openai";
  settings.ai.baseUrl = options.baseUrl ?? "";
  const settingsStore: SettingsStore = {
    path: "/safe/settings.json",
    async load() { return settings; },
    async save(input: unknown) { return validateSettings(input); },
  };
  const app = createApp({
    token,
    workspace,
    clientRoot: "/missing/client",
    version: "0.1.0",
    settingsStore,
    aiSecrets: createAiSecretStore({
      ...(options.withOpenAiKey === false ? {} : { OPENAI_API_KEY: "sk-test-openai-key-1234567890" }),
      ANTHROPIC_API_KEY: "sk-ant-test-key-1234567890",
    }),
    promptStore: { async get() { return { content: "Write valid Manic.", version: "test-prompt", source: "bundled" as const, fetchedAt: 0 }; } },
    openAiProvider: (_apiKey, model, reasoning) => { resolved.push({ provider: "openai", model, reasoning }); return provider; },
    openAiCompatibleProvider: (baseUrl, apiKey, model) => { resolved.push({ provider: "openai-compatible", baseUrl, apiKey, model }); return provider; },
    anthropicProvider: (_apiKey, model, reasoning) => { resolved.push({ provider: "anthropic", model, reasoning }); return provider; },
    engineCheck: async () => ({ ok: true, exitCode: 0, output: "ok" }),
    async diagnostics(_settings: WorkbenchSettings) {
      return {
        engine: { available: true, command: "manic", version: "manic 0.1.0", detail: null },
        ffmpeg: { available: false, command: "ffmpeg", version: null, detail: "Not installed" },
      };
    },
  });
  return { app, provider, resolved };
}

function testApp(clientRoot = "/missing/client", pickWorkspace?: (currentWorkspace: string) => Promise<string | null>, workspace = "/safe/project") {
  let settings = structuredClone(defaultSettings);
  const settingsStore: SettingsStore = {
    path: "/safe/settings.json",
    async load() { return settings; },
    async save(input: unknown) {
      settings = validateSettings(input);
      return settings;
    },
  };
  return createApp({
    token,
    workspace,
    clientRoot,
    version: "0.1.0",
    settingsStore,
    pickWorkspace,
    async diagnostics(_settings: WorkbenchSettings) {
      return {
        engine: { available: true, command: "manic", version: "manic 0.1.0", detail: null },
        ffmpeg: { available: false, command: "ffmpeg", version: null, detail: "Not installed" },
      };
    },
  });
}
