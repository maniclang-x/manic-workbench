import type { WorkbenchSettings } from "./settings.js";
import { delimiter, join } from "node:path";

/** Well-known Manic env vars users commonly set for archive installs. */
export const SUGGESTED_MANIC_ENV_KEYS = ["MANIC_ASSETS_DIR"] as const;

/**
 * From `…/bin/manic` (or manic.exe) infer `…/share/manic/assets`.
 * Returns null when the path is not a `bin/manic` layout.
 */
export function suggestAssetsDirFromEnginePath(enginePath: string): string | null {
  const trimmed = enginePath.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/gu, "/");
  const match = /^(.*)\/bin\/manic(?:\.exe)?$/iu.exec(normalized);
  if (!match?.[1]) return null;
  const root = match[1];
  if (trimmed.includes("\\")) return `${root.replace(/\//gu, "\\")}\\share\\manic\\assets`;
  return `${root}/share/manic/assets`;
}

export function buildManicEnv(
  settings: Pick<WorkbenchSettings, "engineEnv">,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(settings.engineEnv)) {
    if (!value.trim()) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!value.trim()) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Build the engine environment for a workspace. Project uploads live below
 * `.manic/assets`, so the same portable `asset:project/...` URI works in check,
 * native preview, and render without leaking an absolute author-machine path
 * into Manic source.
 */
export function buildWorkspaceManicEnv(
  workspace: string,
  settings: Pick<WorkbenchSettings, "engineEnv">,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = buildManicEnv(settings, extra);
  const projectRoot = join(workspace, ".manic", "assets");
  const existing = (env.MANIC_EXTRA_ASSETS_DIR ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== projectRoot);
  env.MANIC_EXTRA_ASSETS_DIR = [projectRoot, ...existing].join(delimiter);
  return env;
}

/** Fill MANIC_ASSETS_DIR from the engine path when the user has not set it yet. */
export function withSuggestedAssetsDir(
  enginePath: string,
  engineEnv: Record<string, string>,
): Record<string, string> {
  const suggested = suggestAssetsDirFromEnginePath(enginePath);
  if (!suggested) return engineEnv;
  if (Object.prototype.hasOwnProperty.call(engineEnv, "MANIC_ASSETS_DIR") && engineEnv.MANIC_ASSETS_DIR.trim()) {
    return engineEnv;
  }
  return { ...engineEnv, MANIC_ASSETS_DIR: suggested };
}
