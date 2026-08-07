import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunManager } from "./agentRuns.js";
import {
  AnthropicProvider,
  OpenAiProvider,
  runManicAgent,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from "./manicAgent.js";
import { defaultSettings } from "./settings.js";

const prompt = {
  content: "Write valid Manic.",
  version: "test-prompt-version",
  source: "bundled" as const,
  fetchedAt: Date.now(),
};

describe("runManicAgent", () => {
  it("returns a ready proposal when the first candidate validates", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-agent-"));
    const provider = new ScriptedProvider([{
      candidate: {
        operation: "create",
        path: "hello.manic",
        message: "Created a short hello story.",
        content: 'title("Hello");\n',
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }]);
    const events: string[] = [];
    const result = await runManicAgent({
      workspace,
      settings: defaultSettings,
      prompt,
      provider,
      input: { message: "hello", intent: "create", path: "", newPath: "hello.manic", images: [] },
      check: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      onEvent: (event) => events.push(event.state),
    });
    expect(result.status).toBe("ready");
    expect(result.proposal?.content).toContain("Hello");
    expect(result.baseContent).toBe("");
    expect(result.validation.attempts).toBe(1);
    expect(events).toEqual(["fetching_context", "generating", "checking", "ready"]);
  });

  it("forwards exact diagnostics into the repair attempt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-agent-"));
    const provider = new ScriptedProvider([
      {
        candidate: {
          operation: "create",
          path: "story.manic",
          message: "First draft.",
          content: "broken\n",
        },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      {
        candidate: {
          operation: "create",
          path: "story.manic",
          message: "Repaired draft.",
          content: 'title("Fixed");\n',
        },
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      },
    ]);
    const result = await runManicAgent({
      workspace,
      settings: defaultSettings,
      prompt,
      provider,
      input: { message: "fix it", intent: "create", path: "", newPath: "story.manic", images: [] },
      maxRepairAttempts: 3,
      check: async (_workspace, _file, _settings, _override, _signal) => {
        if (provider.calls === 1) return { ok: false, exitCode: 1, output: "exact diagnostic line" };
        return { ok: true, exitCode: 0, output: "ok" };
      },
    });
    expect(result.status).toBe("ready");
    expect(result.validation.attempts).toBe(2);
    expect(provider.requests[1]?.diagnostics).toBe("exact diagnostic line");
  });

  it("stops at the repair limit with a failed proposal the user can inspect", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-agent-"));
    const provider = new ScriptedProvider([
      candidate("a.manic", "one"),
      candidate("a.manic", "two"),
      candidate("a.manic", "three"),
    ]);
    const result = await runManicAgent({
      workspace,
      settings: defaultSettings,
      prompt,
      provider,
      input: { message: "keep failing", intent: "create", path: "", newPath: "a.manic", images: [] },
      maxRepairAttempts: 3,
      check: async () => ({ ok: false, exitCode: 2, output: "still broken" }),
    });
    expect(result.status).toBe("failed");
    expect(result.proposal?.content).toContain("three");
    expect(result.validation.attempts).toBe(3);
  });

  it("cancels when the abort signal fires between attempts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-agent-"));
    const controller = new AbortController();
    const provider: ModelProvider = {
      async generate() {
        controller.abort();
        throw Object.assign(new Error("The AI run was cancelled."), { name: "AbortError" });
      },
    };
    const result = await runManicAgent({
      workspace,
      settings: defaultSettings,
      prompt,
      provider,
      input: { message: "cancel me", intent: "create", path: "", newPath: "c.manic", images: [] },
      signal: controller.signal,
      check: async () => ({ ok: true, exitCode: 0, output: "ok" }),
    });
    expect(result.status).toBe("cancelled");
    expect(result.events.at(-1)?.state).toBe("cancelled");
  });

  it("rejects stale path traversal proposals before checking", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-agent-"));
    const provider = new ScriptedProvider([{
      candidate: {
        operation: "create",
        path: "../escape.manic",
        message: "bad",
        content: 'title("no");\n',
      },
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    }]);
    await expect(runManicAgent({
      workspace,
      settings: defaultSettings,
      prompt,
      provider,
      input: { message: "escape", intent: "create", path: "", newPath: "safe.manic", images: [] },
      check: async () => ({ ok: true, exitCode: 0, output: "ok" }),
    })).rejects.toThrow(/relative \.manic|restricted/u);
  });

  it("forwards authorship-thread conversation context to the provider", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-agent-"));
    const provider = new ScriptedProvider([candidate("t.manic", "turn")]);
    const result = await runManicAgent({
      workspace,
      settings: defaultSettings,
      prompt,
      provider,
      input: { message: "next turn", intent: "create", path: "", newPath: "t.manic", images: [] },
      conversation: "User: earlier request\nAgent (ready, applied): earlier summary",
      check: async () => ({ ok: true, exitCode: 0, output: "ok" }),
    });
    expect(result.status).toBe("ready");
    expect(provider.requests[0]?.conversation).toContain("earlier summary");
  });

  it("includes the active document as base content for replace proposals", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-agent-"));
    await writeFile(join(workspace, "active.manic"), 'title("Old");\n');
    const provider = new ScriptedProvider([{
      candidate: {
        operation: "replace",
        path: "active.manic",
        message: "Updated.",
        content: 'title("New");\n',
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }]);
    const result = await runManicAgent({
      workspace,
      settings: defaultSettings,
      prompt,
      provider,
      input: { message: "update", intent: "refine", path: "active.manic", newPath: "", images: [] },
      check: async () => ({ ok: true, exitCode: 0, output: "ok" }),
    });
    expect(result.status).toBe("ready");
    expect(result.baseContent).toContain("Old");
    expect(result.proposal?.operation).toBe("replace");
    expect(result.proposal?.basedOnRevision).toBeTruthy();
  });
});

describe("provider adapters", () => {
  it("sends OpenAI responses payloads with reasoning effort", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({
        operation: "create", path: "x.manic", message: "ok", content: 'title("X");\n',
      }) }] }],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    }), { status: 200 }));
    const provider = new OpenAiProvider("sk-test-openai-key-1234567890", "gpt-5.6-sol", "low", fetcher as unknown as typeof fetch);
    const result = await provider.generate({ ...sampleRequest(), conversation: "User: earlier steering turn" });
    expect(result.candidate.path).toBe("x.manic");
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.input[0].content[0].text).toContain("<manic_conversation>");
    expect(body.input[0].content[0].text).toContain("earlier steering turn");
  });

  it("sends Anthropic messages payloads with structured output and images", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({
        operation: "create", path: "x.manic", message: "ok", content: 'title("X");\n',
      }) }],
      usage: { input_tokens: 8, output_tokens: 9 },
    }), { status: 200 }));
    const provider = new AnthropicProvider("sk-ant-test-key-1234567890", "claude-sonnet-4-20250514", "none", fetcher as unknown as typeof fetch);
    const result = await provider.generate({
      ...sampleRequest(),
      images: [{ name: "ref.png", dataUrl: "data:image/png;base64,aaaa" }],
    });
    expect(result.usage.totalTokens).toBe(17);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "x-api-key": "sk-ant-test-key-1234567890" });
    const body = JSON.parse(String(init.body));
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages[0].content[0].type).toBe("image");
    // Reasoning "none" must omit thinking/effort so older models keep working.
    expect(body.thinking).toBeUndefined();
    expect(body.output_config.effort).toBeUndefined();
  });

  it("maps Anthropic reasoning levels to adaptive thinking and output effort", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({
        operation: "create", path: "x.manic", message: "ok", content: 'title("X");\n',
      }) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 }));
    const provider = new AnthropicProvider("sk-ant-test-key-1234567890", "claude-sonnet-5", "xhigh", fetcher as unknown as typeof fetch);
    await provider.generate(sampleRequest());
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config.effort).toBe("xhigh");
    expect(body.output_config.format.type).toBe("json_schema");
  });
});

describe("AgentRunManager", () => {
  it("exposes live events and supports cancellation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "manic-agent-run-"));
    const manager = new AgentRunManager();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: ModelProvider = {
      async generate(_request, signal) {
        await gate;
        if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        return candidate("live.manic", "done");
      },
    };
    const view = manager.start({
      workspace,
      settings: defaultSettings,
      prompt,
      provider,
      input: { message: "live", intent: "create", path: "", newPath: "live.manic", images: [] },
      check: async () => ({ ok: true, exitCode: 0, output: "ok" }),
    });
    expect(view.status).toBe("running");
    await vi.waitFor(() => {
      expect(manager.get(view.id)?.events.some((event) => event.state === "generating")).toBe(true);
    });
    const cancelling = manager.cancel(view.id);
    expect(cancelling.status).toBe("running");
    release?.();
    await vi.waitFor(() => {
      expect(manager.get(view.id)?.status).toBe("cancelled");
    });
  });
});

class ScriptedProvider implements ModelProvider {
  calls = 0;
  requests: ModelRequest[] = [];
  constructor(private readonly script: ModelResult[]) {}
  async generate(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    const next = this.script[this.calls];
    this.calls += 1;
    if (!next) throw new Error("Fake provider has no more scripted responses.");
    return next;
  }
}

function candidate(path: string, label: string): ModelResult {
  return {
    candidate: {
      operation: "create",
      path,
      message: label,
      content: `title("${label}");\n`,
    },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function sampleRequest(): ModelRequest {
  return {
    systemPrompt: "system",
    userMessage: "hello",
    intent: "create",
    targetPath: "x.manic",
    activeDocument: null,
    conversation: "",
    images: [],
    diagnostics: "",
    previousCandidate: null,
  };
}
