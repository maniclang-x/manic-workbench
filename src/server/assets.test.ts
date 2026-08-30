import { mkdtemp, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportProjectSmartDraw, importProjectAsset, importProjectSmartDraw, projectAssetsDirectory, renameProjectSmartDraw,
  resolveAsset, searchAssets, trashProjectSmartDraw,
} from "./assets.js";
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

  it("filters and resolves engine-packaged Smart Draw assets", async () => {
    const { workspace, library, settings } = await fixture();
    const page = await searchAssets(workspace, settings, { scope: "library", query: "database", kind: "smartdraw", cursor: null, limit: 48 });
    expect(page.assets).toHaveLength(1);
    expect(page.assets[0]).toMatchObject({ uri: "asset:smartdraw/database.svg", kind: "smartdraw", scope: "library" });
    const resolved = await resolveAsset(workspace, settings, page.assets[0].uri);
    expect(resolved.path).toBe(await realpath(join(library, "smartdraw", "database.svg")));
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

  it("publishes a Smart Draw package only after its adjacent manifest is prepared", async () => {
    const { workspace, settings } = await fixture();
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M1 1L19 9" fill="none" stroke="#111"/></svg>';
    const asset = await importProjectSmartDraw(workspace, new File([source], "Flow Mark.svg"), null, async (sourcePath, guidePath) => {
      expect(guidePath).toBeNull();
      await writeFile(sourcePath.replace(/\.svg$/u, ".draw"), "mode stroke\norder 0\n");
    });
    expect(asset).toMatchObject({ kind: "smartdraw", scope: "project", mediaType: "image/svg+xml", width: 20, height: 10 });
    const resolved = await resolveAsset(workspace, settings, asset.uri);
    expect(await readFile(resolved.path.replace(/\.svg$/u, ".draw"), "utf8")).toContain("mode stroke");
    const page = await searchAssets(workspace, settings, { scope: "project", query: "flow", kind: "smartdraw", cursor: null, limit: 48 });
    expect(page.assets.map((entry) => entry.uri)).toEqual([asset.uri]);
  });

  it("keeps a reveal guide beside its source and rolls back failed preparation", async () => {
    const { workspace } = await fixture();
    const artwork = new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>'], "art.svg");
    const guide = new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M1 5L19 5"/></svg>'], "art.svg");
    let observedGuide = "";
    const asset = await importProjectSmartDraw(workspace, artwork, guide, async (_sourcePath, guidePath) => {
      observedGuide = guidePath ?? "";
      expect(guidePath).toMatch(/reveal-guide\.svg$/u);
      await writeFile(_sourcePath.replace(/\.svg$/u, ".draw"), "manic-smartdraw\nmode reveal\nguide reveal-guide.svg\norder 0\n");
    }, { title: "Reveal Art" });
    expect(await readFile(observedGuide, "utf8")).toContain("<path");
    expect(asset.kind).toBe("smartdraw");

    await expect(importProjectSmartDraw(workspace, new File(['<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>'], "broken.svg"), null, async () => {
      throw new Error("engine rejected package");
    })).rejects.toThrow(/engine rejected/iu);
    const packageDirectories = await readdir(join(projectAssetsDirectory(workspace), "project"));
    expect(packageDirectories).toHaveLength(1);
  });

  it("identifies complete packages, keeps guide variants distinct, and rejects title collisions", async () => {
    const { workspace } = await fixture();
    const sourceText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>';
    const guideA = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M1 2L19 2"/></svg>';
    const guideB = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M1 8L19 8"/></svg>';
    let preparations = 0;
    const prepare = async (sourcePath: string, guidePath: string | null) => {
      preparations += 1;
      await writeFile(sourcePath.replace(/\.svg$/u, ".draw"), `manic-smartdraw\nmode reveal\nguide ${guidePath ? "guide.svg" : ""}\norder 0\n`);
    };
    const first = await importProjectSmartDraw(
      workspace, new File([sourceText], "diagram.svg"), new File([guideA], "guide.svg"), prepare,
      { title: "Diagram A", author: "Ada", sourceUrl: "https://example.test/source", license: { id: "CC-BY-4.0", name: "CC BY 4.0", attributionRequired: true, attribution: "Ada", url: "https://creativecommons.org/licenses/by/4.0/" } },
    );
    const duplicate = await importProjectSmartDraw(
      workspace, new File([sourceText], "renamed.svg"), new File([guideA], "other-guide.svg"), prepare,
      { title: "Ignored duplicate title" },
    );
    const variant = await importProjectSmartDraw(
      workspace, new File([sourceText], "diagram.svg"), new File([guideB], "guide.svg"), prepare,
      { title: "Diagram B" },
    );
    expect(duplicate.uri).toBe(first.uri);
    expect(variant.uri).not.toBe(first.uri);
    expect(preparations).toBe(2);
    expect(first).toMatchObject({
      title: "Diagram A", provenance: { author: "Ada", sourceUrl: "https://example.test/source", importedFilename: "diagram.svg" },
      license: { id: "CC-BY-4.0", attributionRequired: true },
    });
    const revealExport = await exportProjectSmartDraw(workspace, first.uri);
    expect(revealExport.bytes.includes(Buffer.from("guide.svg"))).toBe(true);
    await expect(importProjectSmartDraw(
      workspace, new File([sourceText.replace("20 10", "30 10")], "another.svg"), null,
      async (sourcePath) => writeFile(sourcePath.replace(/\.svg$/u, ".draw"), "manic-smartdraw\nmode stroke\norder 0\n"),
      { title: "Diagram A" },
    )).rejects.toThrow(/already named/iu);
  });

  it("serializes concurrent package mutations so catalogue entries are not lost", async () => {
    const { workspace, settings } = await fixture();
    const prepare = async (sourcePath: string) => {
      await writeFile(sourcePath.replace(/\.svg$/u, ".draw"), "manic-smartdraw\nmode stroke\norder 0\n");
    };
    await Promise.all([
      importProjectSmartDraw(workspace, new File(['<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>'], "one.svg"), null, prepare),
      importProjectSmartDraw(workspace, new File(['<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 1L1 0"/></svg>'], "two.svg"), null, prepare),
    ]);
    const page = await searchAssets(workspace, settings, { scope: "project", query: "", kind: "smartdraw", cursor: null, limit: 48 });
    expect(page.assets.map((asset) => asset.title).sort()).toEqual(["One", "Two"]);
  });

  it("renames by metadata, exports the complete unit, and moves deletion to recoverable trash", async () => {
    const { workspace, settings } = await fixture();
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M1 1L19 9"/></svg>';
    const asset = await importProjectSmartDraw(workspace, new File([source], "flow.svg"), null, async (sourcePath) => {
      await writeFile(sourcePath.replace(/\.svg$/u, ".draw"), "manic-smartdraw\nmode stroke\norder 0\n");
    });
    const renamed = await renameProjectSmartDraw(workspace, asset.uri, "System Flow");
    expect(renamed).toMatchObject({ uri: asset.uri, title: "System Flow" });
    const exported = await exportProjectSmartDraw(workspace, asset.uri);
    expect(exported.filename).toBe("system-flow.manic-smartdraw.zip");
    expect(exported.bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(exported.bytes.includes(Buffer.from("flow.svg"))).toBe(true);
    expect(exported.bytes.includes(Buffer.from("flow.draw"))).toBe(true);
    expect(exported.bytes.includes(Buffer.from("manic-smartdraw-package.json"))).toBe(true);

    await trashProjectSmartDraw(workspace, asset.uri);
    const page = await searchAssets(workspace, settings, { scope: "project", query: "flow", kind: "smartdraw", cursor: null, limit: 48 });
    expect(page.assets).toHaveLength(0);
    await expect(resolveAsset(workspace, settings, asset.uri)).rejects.toThrow(/not registered/iu);
    const trash = await readdir(join(workspace, ".manic", "trash", "assets"));
    expect(trash).toHaveLength(1);
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
  await mkdir(join(library, "smartdraw"), { recursive: true });
  await writeFile(join(library, "logos", "manic.png"), "png");
  await writeFile(join(library, "internal", "guide.svg"), "<svg/>");
  await writeFile(join(library, "smartdraw", "database.svg"), "<svg/>");
  await writeFile(join(library, "smartdraw", "database.draw"), "mode stroke\norder 0\n");
  await writeFile(join(library, "catalogue-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    assets: [
      asset("asset:logos/manic.png", "image", "image/png", "Manic logo", true),
      asset("asset:internal/guide.svg", "svg", "image/svg+xml", "Internal guide", false),
      asset("asset:smartdraw/database.svg", "smartdraw", "image/svg+xml", "Database", true),
    ],
  }));
  const settings = structuredClone(defaultSettings);
  settings.engineEnv.MANIC_ASSETS_DIR = library;
  return { workspace, library, settings };
}

function asset(uri: string, kind: "image" | "svg" | "smartdraw" | "model", mediaType: string, title: string, uiVisible: boolean) {
  return {
    uri, kind, mediaType, title, uiVisible, category: ["test"], keywords: title.toLowerCase().split(" "),
    byteSize: 3, sha256: "0".repeat(64), themeable: false, license: null, warnings: [],
  };
}
