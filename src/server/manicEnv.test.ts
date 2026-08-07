import { describe, expect, it } from "vitest";
import { buildManicEnv, suggestAssetsDirFromEnginePath, withSuggestedAssetsDir } from "./manicEnv.js";
import { validateSettings } from "./settings.js";

describe("Manic environment helpers", () => {
  it("infers MANIC_ASSETS_DIR from a bin/manic archive layout", () => {
    expect(suggestAssetsDirFromEnginePath("/Users/anish/Downloads/manic-aarch64-apple-darwin/bin/manic"))
      .toBe("/Users/anish/Downloads/manic-aarch64-apple-darwin/share/manic/assets");
    expect(suggestAssetsDirFromEnginePath("C:\\Tools\\manic-x64\\bin\\manic.exe")?.replace(/\\/gu, "/"))
      .toMatch(/\/share\/manic\/assets$/u);
    expect(suggestAssetsDirFromEnginePath("/usr/local/bin/manic")).toBe("/usr/local/share/manic/assets");
    expect(suggestAssetsDirFromEnginePath("/opt/homebrew/bin/manic")).toBe("/opt/homebrew/share/manic/assets");
    expect(suggestAssetsDirFromEnginePath("manic")).toBeNull();
  });

  it("fills a missing assets dir without overwriting a custom value", () => {
    const path = "/opt/manic/bin/manic";
    expect(withSuggestedAssetsDir(path, {})).toEqual({
      MANIC_ASSETS_DIR: "/opt/manic/share/manic/assets",
    });
    expect(withSuggestedAssetsDir(path, { MANIC_ASSETS_DIR: "/custom/assets" })).toEqual({
      MANIC_ASSETS_DIR: "/custom/assets",
    });
  });

  it("merges engineEnv into the process environment for Manic spawns", () => {
    const env = buildManicEnv(
      { engineEnv: { MANIC_ASSETS_DIR: "/tmp/assets" } },
      { MANIC_PROGRESS: "json" },
    );
    expect(env.MANIC_ASSETS_DIR).toBe("/tmp/assets");
    expect(env.MANIC_PROGRESS).toBe("json");
  });

  it("validates MANIC_* engineEnv entries in settings", () => {
    const settings = validateSettings({
      engineEnv: { manic_assets_dir: "/tmp/assets", MANIC_EMPTY: "  " },
    });
    expect(settings.engineEnv).toEqual({ MANIC_ASSETS_DIR: "/tmp/assets" });
    expect(() => validateSettings({ engineEnv: { OPENAI_API_KEY: "nope" } })).toThrow(/MANIC_/);
  });
});
