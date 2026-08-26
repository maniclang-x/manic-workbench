import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importProjectAsset, projectAssetsDirectory, resolveAsset, searchAssets } from "./assets.js";
import { defaultSettings } from "./settings.js";

describe("Workbench asset catalogues", () => {
  it("searches only discoverable Library entries but resolves hidden source assets", async () => {
    const { workspace, library, settings } = await fixture();
    const page = await searchAssets(workspace, settings, { scope: "library", query: "logo", kind: "all", cursor: null, limit: 48 });
    expect(page.total).toBe(1);
    expect(page.assets[0]).toMatchObject({ uri: "asset:logos/manic.png", scope: "library", kind: "image" });
    const hidden = await resolveAsset(workspace, settings, "asset:internal/guide.svg");
    expect(hidden.path).toBe(await realpath(join(library, "internal", "guide.svg")));
    expect(hidden.asset.scope).toBe("library");
  });

  it("imports, deduplicates, catalogues, and resolves portable project SVG assets", async () => {
    const { workspace, settings } = await fixture();
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><path fill="currentColor" d="M0 0h24v12H0z"/></svg>';
    const first = await importProjectAsset(workspace, new File([source], "My Mark.svg", { type: "image/svg+xml" }));
    const duplicate = await importProjectAsset(workspace, new File([source], "copy.svg", { type: "image/svg+xml" }));
    expect(first.uri).toMatch(/^asset:project\/[0-9a-f-]+\/my-mark\.svg$/u);
    expect(duplicate.uri).toBe(first.uri);
    expect(first).toMatchObject({ kind: "svg", scope: "project", width: 24, height: 12, themeable: true });
    const page = await searchAssets(workspace, settings, { scope: "project", query: "mark", kind: "svg", cursor: null, limit: 48 });
    expect(page.assets).toHaveLength(1);
    const resolved = await resolveAsset(workspace, settings, first.uri);
    expect(resolved.path.startsWith(await realpath(projectAssetsDirectory(workspace)))).toBe(true);
    expect(await readFile(resolved.path, "utf8")).toBe(source);
  });

  it("imports geometry-only OBJ assets and exposes assembly part names", async () => {
    const { workspace, settings } = await fixture();
    const source = "o base panel\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\ng screen/main\nl 1 2\n";
    const model = await importProjectAsset(workspace, new File([source], "Console.obj", { type: "model/obj" }));
    expect(model).toMatchObject({ kind: "model", mediaType: "model/obj", parts: ["base_panel", "screen_main"] });
    const page = await searchAssets(workspace, settings, { scope: "project", query: "console", kind: "model", cursor: null, limit: 48 });
    expect(page.assets).toHaveLength(1);
    const resolved = await resolveAsset(workspace, settings, model.uri);
    expect(await readFile(resolved.path, "utf8")).toBe(source);
  });

  it("rejects active SVG content and unsafe asset paths", async () => {
    const { workspace, settings } = await fixture();
    await expect(importProjectAsset(workspace, new File(['<svg><script>alert(1)</script></svg>'], "bad.svg")))
      .rejects.toThrow(/not allowed/iu);
    await expect(importProjectAsset(workspace, new File(['<svg><image href="https://example.com/x.png"/></svg>'], "remote.svg")))
      .rejects.toThrow(/external/iu);
    await expect(resolveAsset(workspace, settings, "asset:../secret.png")).rejects.toThrow(/safe asset/iu);
  });

  it("never follows a project control-directory symlink during upload", async () => {
    const { workspace } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "manic-assets-outside-"));
    await symlink(outside, join(workspace, ".manic"));
    await expect(importProjectAsset(workspace, new File(["<svg/>"], "mark.svg"))).rejects.toThrow(/not safe/iu);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "manic-assets-test-"));
  const workspace = join(root, "workspace"), library = join(root, "library");
  await mkdir(workspace);
  await mkdir(join(library, "logos"), { recursive: true });
  await mkdir(join(library, "internal"), { recursive: true });
  await writeFile(join(library, "logos", "manic.png"), "png");
  await writeFile(join(library, "internal", "guide.svg"), "<svg/>");
  await writeFile(join(library, "catalogue-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    assets: [
      asset("asset:logos/manic.png", "image", "image/png", "Manic logo", true),
      asset("asset:internal/guide.svg", "svg", "image/svg+xml", "Internal guide", false),
    ],
  }));
  const settings = structuredClone(defaultSettings);
  settings.engineEnv.MANIC_ASSETS_DIR = library;
  return { workspace, library, settings };
}

function asset(uri: string, kind: "image" | "svg" | "model", mediaType: string, title: string, uiVisible: boolean) {
  return {
    uri, kind, mediaType, title, uiVisible, category: ["test"], keywords: title.toLowerCase().split(" "),
    byteSize: 3, sha256: "0".repeat(64), themeable: false, license: null, warnings: [],
  };
}
