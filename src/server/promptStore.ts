import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export const MANIC_SYSTEM_PROMPT_URL = "https://8gwifi.org/manic/system-prompt.md";
const FALLBACK_PROMPT = `You create valid, readable Manic source for visual explanations.
Return a complete .manic document. Prefer meaningful Manic vocabulary, named entities,
responsive coordinates, smooth steps, and a clear story. Never invent unsupported syntax.`;

export interface ManicPrompt {
  content: string;
  version: string;
  source: "remote" | "cache" | "bundled";
  fetchedAt: number;
}

interface CachedPrompt {
  content: string;
  fetchedAt: number;
  etag: string;
  lastModified: string;
}

export interface PromptStore {
  get(force?: boolean): Promise<ManicPrompt>;
}

export function createPromptStore(
  path = process.env.MANIC_WORKBENCH_PROMPT_CACHE || userPromptCachePath(),
  fetcher: typeof fetch = fetch,
): PromptStore {
  return {
    async get(force = false) {
      const cached = await readCache(path);
      if (!force && cached && Date.now() - cached.fetchedAt < 6 * 60 * 60 * 1000) return prompt(cached, "cache");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const headers = new Headers({ Accept: "text/markdown, text/plain;q=0.9" });
        if (cached?.etag) headers.set("If-None-Match", cached.etag);
        if (cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);
        const response = await fetcher(MANIC_SYSTEM_PROMPT_URL, { headers, signal: controller.signal });
        if (response.status === 304 && cached) {
          const refreshed = { ...cached, fetchedAt: Date.now() };
          await writeCache(path, refreshed);
          return prompt(refreshed, "cache");
        }
        if (!response.ok) throw new Error(`System prompt request failed (${response.status}).`);
        const length = Number(response.headers.get("Content-Length") ?? "0");
        if (length > 2 * 1024 * 1024) throw new Error("System prompt is too large.");
        const content = await response.text();
        if (!content.trim() || Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) throw new Error("System prompt is empty or too large.");
        const next = {
          content, fetchedAt: Date.now(), etag: response.headers.get("ETag") ?? "",
          lastModified: response.headers.get("Last-Modified") ?? "",
        };
        await writeCache(path, next);
        return prompt(next, "remote");
      } catch {
        if (cached) return prompt(cached, "cache");
        return { content: FALLBACK_PROMPT, version: hash(FALLBACK_PROMPT), source: "bundled", fetchedAt: 0 };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function userPromptCachePath(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "Manic Workbench", "system-prompt.json");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Manic Workbench", "system-prompt.json");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "manic-workbench", "system-prompt.json");
}

async function readCache(path: string): Promise<CachedPrompt | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<CachedPrompt>;
    return typeof value.content === "string" && typeof value.fetchedAt === "number"
      ? { content: value.content, fetchedAt: value.fetchedAt, etag: value.etag ?? "", lastModified: value.lastModified ?? "" }
      : null;
  } catch { return null; }
}

async function writeCache(path: string, value: CachedPrompt): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function prompt(value: CachedPrompt, source: ManicPrompt["source"]): ManicPrompt {
  return { content: value.content, version: hash(value.content), source, fetchedAt: value.fetchedAt };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
