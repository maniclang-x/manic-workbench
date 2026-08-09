import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSettingsStore, defaultSettings, modelsForProvider, validateSettings } from "./settings.js";

describe("Workbench settings", () => {
  it("applies safe defaults", () => {
    expect(validateSettings({})).toEqual(defaultSettings);
  });

  it("rejects values outside the supported preview range", () => {
    expect(() => validateSettings({ preview: { fps: 241 } })).toThrow("preview.fps must be between 1 and 240");
    expect(() => validateSettings({ preview: { scale: Number.NaN } })).toThrow("preview.scale must be between 0.1 and 8");
  });

  it("accepts custom AI models and merges them into the provider catalog", () => {
    const settings = validateSettings({
      ai: {
        provider: "openai",
        model: "my-fine-tune",
        customModels: { openai: ["my-fine-tune", "gpt-5.6"], anthropic: ["claude-custom"] },
      },
    });
    expect(settings.ai.customModels.openai).toEqual(["my-fine-tune"]);
    expect(modelsForProvider("openai", settings.ai.customModels)).toContain("my-fine-tune");
    expect(modelsForProvider("anthropic", settings.ai.customModels)).toContain("claude-custom");
  });

  it("rejects invalid custom model ids", () => {
    expect(() => validateSettings({ ai: { customModels: { openai: ["bad model"] } } })).toThrow("invalid model id");
  });

  it("accepts an OpenAI-compatible base URL and normalizes trailing slashes", () => {
    expect(validateSettings({ ai: { baseUrl: "http://localhost:11434/v1/" } }).ai.baseUrl).toBe("http://localhost:11434/v1");
    expect(validateSettings({ ai: { baseUrl: "  " } }).ai.baseUrl).toBe("");
    expect(validateSettings({ ai: { baseUrl: "https://vllm.internal:8000/v1" } }).ai.baseUrl).toBe("https://vllm.internal:8000/v1");
  });

  it("normalizes bare hosts the way people type them", () => {
    expect(validateSettings({ ai: { baseUrl: "127.0.0.1:11434" } }).ai.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(validateSettings({ ai: { baseUrl: "localhost:11434/v1" } }).ai.baseUrl).toBe("http://localhost:11434/v1");
    expect(validateSettings({ ai: { baseUrl: "http://localhost:1234" } }).ai.baseUrl).toBe("http://localhost:1234/v1");
    expect(validateSettings({ ai: { baseUrl: "https://gateway.example.com/openai" } }).ai.baseUrl).toBe("https://gateway.example.com/openai");
  });

  it("rejects base URLs that are not http(s)", () => {
    expect(() => validateSettings({ ai: { baseUrl: "not a url" } })).toThrow("valid http(s) URL");
    expect(() => validateSettings({ ai: { baseUrl: "ftp://host/v1" } })).toThrow("http or https");
  });

  it("writes user settings privately and reads them back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "manic-workbench-settings-"));
    const path = join(directory, "nested", "settings.json");
    const store = createSettingsStore(path);
    const expected = { ...defaultSettings, updateChannel: "latest" as const, preview: { ...defaultSettings.preview, fps: 30 } };
    await expect(store.save(expected)).resolves.toEqual(expected);
    await expect(store.load()).resolves.toEqual(expected);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
