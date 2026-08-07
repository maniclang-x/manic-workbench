import { describe, expect, it } from "vitest";
import { createAiSecretStore, normalizeSecretName } from "./aiSecrets.js";

describe("AI secret store", () => {
  it("reads known keys from the process environment", () => {
    const store = createAiSecretStore({ OPENAI_API_KEY: "sk-env-openai-key-1234567890", ANTHROPIC_API_KEY: "sk-ant-env-key-1234567890" });
    expect(store.status().entries).toEqual([
      { key: "ANTHROPIC_API_KEY", configured: true, source: "environment" },
      { key: "OPENAI_API_KEY", configured: true, source: "environment" },
    ]);
    expect(store.openAiKey()).toBe("sk-env-openai-key-1234567890");
    expect(store.anthropicKey()).toBe("sk-ant-env-key-1234567890");
  });

  it("lets the session override and clear provider keys without touching the environment", () => {
    const store = createAiSecretStore({ OPENAI_API_KEY: "sk-env-openai-key-1234567890" });
    store.set("OPENAI_API_KEY", "sk-session-openai-key-1234567890");
    store.set("CUSTOM_GATEWAY_TOKEN", "custom-session-token-123456");
    expect(store.openAiKey()).toBe("sk-session-openai-key-1234567890");
    expect(store.get("CUSTOM_GATEWAY_TOKEN")).toBe("custom-session-token-123456");
    expect(store.status().entries.find((entry) => entry.key === "OPENAI_API_KEY")).toMatchObject({ source: "session" });
    store.clear("OPENAI_API_KEY");
    expect(store.openAiKey()).toBe("sk-env-openai-key-1234567890");
    expect(store.status().entries.find((entry) => entry.key === "OPENAI_API_KEY")).toMatchObject({ source: "environment" });
  });

  it("rejects malformed secret names and values", () => {
    const store = createAiSecretStore({});
    expect(() => normalizeSecretName("openai api key")).toThrow(/ENV_NAMES/);
    expect(() => store.set("OPENAI_API_KEY", "short")).toThrow(/valid API key/);
  });
});
