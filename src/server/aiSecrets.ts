export type AiSecretSource = "environment" | "session" | "none";

export interface AiSecretEntryStatus {
  key: string;
  configured: boolean;
  source: AiSecretSource;
}

export interface AiSecretStatus {
  entries: AiSecretEntryStatus[];
}

export interface AiSecretStore {
  status(): AiSecretStatus;
  get(key: string): string;
  set(key: string, value: string): void;
  clear(key: string): void;
  /** Convenience for the OpenAI adapter. */
  openAiKey(): string;
  anthropicKey(): string;
}

export const KNOWN_AI_SECRET_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

const ENVIRONMENT_ALIASES: Record<string, string[]> = {
  OPENAI_API_KEY: ["OPENAI_API_KEY"],
  ANTHROPIC_API_KEY: ["ANTHROPIC_API_KEY"],
};

export function createAiSecretStore(environment = process.env): AiSecretStore {
  const environmentKeys = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(ENVIRONMENT_ALIASES)) {
    for (const alias of aliases) {
      const value = normalizedKey(environment[alias] ?? "", { allowEmpty: true });
      if (value) {
        environmentKeys.set(canonical, value);
        break;
      }
    }
  }

  const sessionKeys = new Map<string, string>();

  return {
    status() {
      const keys = new Set<string>([...KNOWN_AI_SECRET_KEYS, ...sessionKeys.keys(), ...environmentKeys.keys()]);
      return {
        entries: [...keys].sort().map((key) => {
          if (sessionKeys.has(key)) return { key, configured: true, source: "session" as const };
          if (environmentKeys.has(key)) return { key, configured: true, source: "environment" as const };
          return { key, configured: false, source: "none" as const };
        }),
      };
    },
    get(key) {
      const normalized = normalizeSecretName(key);
      return sessionKeys.get(normalized) ?? environmentKeys.get(normalized) ?? "";
    },
    set(key, value) {
      const normalized = normalizeSecretName(key);
      sessionKeys.set(normalized, normalizedKey(value));
    },
    clear(key) {
      sessionKeys.delete(normalizeSecretName(key));
    },
    openAiKey() { return this.get("OPENAI_API_KEY"); },
    anthropicKey() { return this.get("ANTHROPIC_API_KEY"); },
  };
}

export function normalizeSecretName(value: string): string {
  const key = value.trim().toUpperCase();
  if (!key) throw new Error("Secret key is required.");
  if (key.length > 64) throw new Error("Secret key is too long.");
  if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
    throw new Error("Secret keys must look like ENV_NAMES, for example OPENAI_API_KEY.");
  }
  return key;
}

function normalizedKey(value: string, options?: { allowEmpty?: boolean }): string {
  const key = value.trim();
  if (!key) {
    if (options?.allowEmpty) return "";
    throw new Error("Enter a valid API key.");
  }
  if (key.length < 12 || key.length > 512 || /\s/u.test(key)) throw new Error("Enter a valid API key.");
  return key;
}
