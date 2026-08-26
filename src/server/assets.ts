import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { ManicAsset, ManicAssetKind, ManicAssetPage, ManicAssetScope } from "@maniclang/scene";
import type { WorkbenchSettings } from "./settings.js";
import { suggestAssetsDirFromEnginePath } from "./manicEnv.js";

const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const PROJECT_MANIFEST = ".manic/assets.json";
const PROJECT_ASSET_ROOT = ".manic/assets";

interface ProjectAssetRecord extends ManicAsset { createdAt: number; }
interface ProjectManifest { schemaVersion: 1; assets: ProjectAssetRecord[]; }
interface LibraryEntry extends Omit<ManicAsset, "scope"> { uiVisible: boolean; }
interface LibraryManifest { schemaVersion: number; assets: LibraryEntry[]; }
interface AssetSearchInput { scope: ManicAssetScope; query: string; kind: ManicAssetKind | "all"; cursor: string | null; limit: number; }

const libraryCache = new Map<string, { signature: string; manifest: LibraryManifest }>();

export async function searchAssets(workspace: string, settings: WorkbenchSettings, input: AssetSearchInput, engineOverride = ""): Promise<ManicAssetPage> {
  const source = input.scope === "project"
    ? (await readProjectManifest(workspace)).assets
    : (await readLibraryManifest(settings, engineOverride)).assets.filter((asset) => asset.uiVisible).map((asset) => ({ ...asset, scope: "library" as const }));
  const needle = input.query.trim().toLowerCase();
  const filtered = source.filter((asset) => (input.kind === "all" || asset.kind === input.kind) && (!needle || searchable(asset).includes(needle)));
  const offset = parseCursor(input.cursor);
  const limit = Math.max(1, Math.min(100, Math.round(input.limit) || 48));
  const assets = filtered.slice(offset, offset + limit).map(publicAsset);
  const next = offset + assets.length;
  return { assets, total: filtered.length, nextCursor: next < filtered.length ? String(next) : null };
}

export async function resolveAsset(workspace: string, settings: WorkbenchSettings, uri: string, engineOverride = ""): Promise<{ asset: ManicAsset; path: string }> {
  validateAssetUri(uri);
  if (uri.startsWith("asset:project/")) {
    const manifest = await readProjectManifest(workspace);
    const asset = manifest.assets.find((candidate) => candidate.uri === uri);
    if (!asset) throw new Error(`Project asset is not registered: ${uri}`);
    const root = join(await realpath(workspace), PROJECT_ASSET_ROOT);
    return { asset: publicAsset(asset), path: await safeExistingAsset(root, uri.slice("asset:".length)) };
  }
  const root = await libraryRoot(settings, engineOverride);
  const manifest = await readLibraryManifest(settings, engineOverride);
  const entry = manifest.assets.find((candidate) => candidate.uri === uri);
  if (!entry) throw new Error(`Bundled asset is not in the catalogue: ${uri}`);
  return { asset: publicAsset({ ...entry, scope: "library" }), path: await safeExistingAsset(root, uri.slice("asset:".length)) };
}

export async function importProjectAsset(workspace: string, file: File): Promise<ManicAsset> {
  if (!file.name || file.name.includes("\0")) throw new Error("The uploaded asset needs a filename.");
  if (file.size < 1) throw new Error("The uploaded asset is empty.");
  if (file.size > MAX_ASSET_BYTES) throw new Error("Project assets cannot exceed 16 MB.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const inspected = inspectAsset(file.name, bytes);
  const manifest = await readProjectManifest(workspace);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const duplicate = manifest.assets.find((asset) => asset.sha256 === sha256 && asset.mediaType === inspected.mediaType);
  if (duplicate) return publicAsset(duplicate);

  const id = randomUUID();
  const filename = safeFilename(file.name, inspected.extension);
  const relativePath = `project/${id}/${filename}`;
  const root = await ensureProjectAssetRoot(workspace);
  const directory = join(root, "project", id);
  await mkdir(directory, { mode: 0o700 });
  const target = join(directory, filename);
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });

  const asset: ProjectAssetRecord = {
    uri: `asset:${relativePath}`,
    kind: inspected.kind,
    scope: "project",
    mediaType: inspected.mediaType,
    title: titleFromName(filename),
    category: ["project"],
    keywords: tokens(filename),
    byteSize: bytes.length,
    sha256,
    ...(inspected.width && inspected.height ? { width: inspected.width, height: inspected.height, aspectRatio: Number((inspected.width / inspected.height).toFixed(6)) } : {}),
    ...(inspected.parts.length ? { parts: inspected.parts } : {}),
    themeable: inspected.themeable,
    license: null,
    warnings: inspected.warnings,
    createdAt: Date.now(),
  };
  manifest.assets.push(asset);
  await writeProjectManifest(workspace, manifest);
  return publicAsset(asset);
}

export function projectAssetsDirectory(workspace: string): string {
  return join(workspace, PROJECT_ASSET_ROOT);
}

async function libraryRoot(settings: WorkbenchSettings, engineOverride: string): Promise<string> {
  const configured = settings.engineEnv.MANIC_ASSETS_DIR?.trim() || process.env.MANIC_ASSETS_DIR?.trim();
  const inferred = suggestAssetsDirFromEnginePath(engineOverride || settings.enginePath || process.env.MANIC_BIN || "");
  const candidate = configured || inferred;
  if (!candidate) throw new Error("Configure MANIC_ASSETS_DIR to browse bundled assets.");
  const root = resolve(candidate);
  const information = await lstat(root).catch(() => null);
  if (!information?.isDirectory() || information.isSymbolicLink()) throw new Error(`MANIC_ASSETS_DIR is not a safe directory: ${root}`);
  return realpath(root);
}

async function readLibraryManifest(settings: WorkbenchSettings, engineOverride: string): Promise<LibraryManifest> {
  const root = await libraryRoot(settings, engineOverride);
  const path = join(root, "catalogue-manifest.json");
  const information = await stat(path).catch(() => null);
  if (!information?.isFile()) throw new Error(`Asset catalogue is missing. Run scripts/gen-asset-catalog.py for ${root}.`);
  const signature = `${information.mtimeMs}:${information.size}`;
  const cached = libraryCache.get(path);
  if (cached?.signature === signature) return cached.manifest;
  const parsed = JSON.parse(await readFile(path, "utf8")) as LibraryManifest;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.assets)) throw new Error("The bundled asset catalogue schema is not supported.");
  libraryCache.set(path, { signature, manifest: parsed });
  return parsed;
}

async function readProjectManifest(workspace: string): Promise<ProjectManifest> {
  const root = await realpath(workspace);
  const manic = join(root, ".manic");
  const directory = await lstat(manic).catch(() => null);
  if (!directory) return { schemaVersion: 1, assets: [] };
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(manic) !== manic) throw new Error("The project .manic directory is not safe to use.");
  const path = join(root, PROJECT_MANIFEST);
  const information = await lstat(path).catch(() => null);
  if (!information) return { schemaVersion: 1, assets: [] };
  if (!information.isFile() || information.isSymbolicLink()) throw new Error("The project asset catalogue is not a safe file.");
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!raw) return { schemaVersion: 1, assets: [] };
  const parsed = JSON.parse(raw) as ProjectManifest;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.assets)) throw new Error("The project asset catalogue is invalid.");
  return parsed;
}

async function writeProjectManifest(workspace: string, manifest: ProjectManifest): Promise<void> {
  const root = await ensureProjectAssetRoot(workspace);
  const target = join(dirname(root), "assets.json");
  const temporary = join(dirname(root), `.assets-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ ...manifest, assets: [...manifest.assets].sort((a, b) => a.uri.localeCompare(b.uri)) }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}

async function ensureProjectAssetRoot(workspace: string): Promise<string> {
  const canonicalWorkspace = await realpath(workspace);
  const manic = join(canonicalWorkspace, ".manic");
  const root = join(manic, "assets");
  if (!await lstat(manic).catch(() => null)) await mkdir(manic, { mode: 0o700 });
  assertSafeDirectory(manic, await lstat(manic), await realpath(manic));
  if (!await lstat(root).catch(() => null)) await mkdir(root, { mode: 0o700 });
  for (const directory of [manic, root]) {
    const information = await lstat(directory);
    assertSafeDirectory(directory, information, await realpath(directory));
  }
  const project = join(root, "project");
  if (!await lstat(project).catch(() => null)) await mkdir(project, { mode: 0o700 });
  assertSafeDirectory(project, await lstat(project), await realpath(project));
  return root;
}

function assertSafeDirectory(expected: string, information: Awaited<ReturnType<typeof lstat>>, canonical: string): void {
  if (!information.isDirectory() || information.isSymbolicLink() || canonical !== expected) throw new Error("The project asset directory is not safe to use.");
}

async function safeExistingAsset(root: string, localPath: string): Promise<string> {
  if (!localPath || localPath.includes("\0") || localPath.startsWith("/") || localPath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Asset paths must stay inside their configured root.");
  const canonicalRoot = await realpath(root);
  const candidate = join(canonicalRoot, ...localPath.split("/"));
  const information = await lstat(candidate).catch(() => null);
  if (!information?.isFile() || information.isSymbolicLink()) throw new Error(`Asset file is missing: asset:${localPath}`);
  const absolute = await realpath(candidate);
  const local = relative(canonicalRoot, absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`)) throw new Error("Asset access escaped its configured root.");
  return absolute;
}

function publicAsset(asset: ManicAsset | ProjectAssetRecord): ManicAsset {
  const { createdAt: _createdAt, ...result } = asset as ProjectAssetRecord;
  return result;
}

function searchable(asset: ManicAsset): string {
  return [asset.title, asset.uri, ...asset.category, ...asset.keywords].join(" ").toLowerCase();
}

function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validateAssetUri(uri: string): void {
  if (!uri.startsWith("asset:") || uri.includes("\0") || uri.slice(6).startsWith("/") || uri.slice(6).split("/").some((part) => !part || part === "." || part === "..")) throw new Error("A safe asset: URI is required.");
}

function inspectAsset(name: string, data: Buffer): { kind: ManicAssetKind; mediaType: string; extension: string; width: number | null; height: number | null; themeable: boolean; warnings: string[]; parts: string[] } {
  const suffix = extname(name).toLowerCase();
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (data.length < 24 || data.toString("ascii", 12, 16) !== "IHDR") throw new Error("The PNG header is invalid.");
    return { kind: "image", mediaType: "image/png", extension: ".png", width: data.readUInt32BE(16), height: data.readUInt32BE(20), themeable: false, warnings: suffix === ".png" ? [] : ["filename-extension-normalized"], parts: [] };
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    const dimensions = jpegDimensions(data);
    return { kind: "image", mediaType: "image/jpeg", extension: suffix === ".jpeg" ? ".jpeg" : ".jpg", width: dimensions?.width ?? null, height: dimensions?.height ?? null, themeable: false, warnings: dimensions ? [] : ["missing-raster-dimensions"], parts: [] };
  }
  const source = data.toString("utf8");
  if (/<svg\b/iu.test(source.slice(0, 4096))) {
    validateSvg(source);
    const dimensions = svgDimensions(source);
    const markup = source.replaceAll(/<!--[^]*?-->/gu, "");
    const warnings = [
      [/<(?:clipPath)\b/iu, "native-svg-skips-clip-path"], [/<mask\b/iu, "native-svg-skips-mask"],
      [/<filter\b/iu, "native-svg-skips-filter"], [/<(?:linearGradient|radialGradient)\b/iu, "native-svg-skips-gradient-paint"],
      [/<pattern\b/iu, "native-svg-skips-pattern-paint"], [/<text\b/iu, "native-svg-skips-text"], [/<image\b/iu, "native-svg-skips-embedded-image"],
    ].flatMap(([pattern, warning]) => (pattern as RegExp).test(markup) ? [warning as string] : []);
    if (!dimensions) warnings.push("missing-svg-intrinsic-dimensions");
    return { kind: "svg", mediaType: "image/svg+xml", extension: ".svg", width: dimensions?.width ?? null, height: dimensions?.height ?? null, themeable: /currentColor/iu.test(markup), warnings: [...new Set(warnings)].sort(), parts: [] };
  }
  if (suffix === ".obj") {
    const parts: string[] = [], warnings: string[] = [];
    let vertices = 0, drawable = 0;
    for (const line of source.split(/\r?\n/u)) {
      const fields = line.trim().split(/\s+/u);
      if (!fields[0] || fields[0].startsWith("#")) continue;
      if (fields[0] === "v") {
        if (fields.length < 4 || fields.slice(1, 4).some((value) => !Number.isFinite(Number(value)))) throw new Error("The OBJ contains an invalid vertex.");
        vertices += 1;
      } else if (fields[0] === "f" || fields[0] === "l") {
        if (fields.length < (fields[0] === "f" ? 4 : 3)) throw new Error("The OBJ contains invalid drawable geometry.");
        drawable += 1;
      } else if ((fields[0] === "o" || fields[0] === "g") && fields.length > 1) {
        const part = fields.slice(1).join("_").replaceAll(/[^A-Za-z0-9_-]+/gu, "_").replaceAll(/_+/gu, "_").replaceAll(/^_+|_+$/gu, "").slice(0, 80);
        if (part && !parts.includes(part)) parts.push(part);
      } else if (fields[0] === "mtllib" || fields[0] === "usemtl") warnings.push("obj-materials-ignored");
    }
    if (!vertices || !drawable) throw new Error("The OBJ needs vertices and face or line geometry.");
    return { kind: "model", mediaType: "model/obj", extension: ".obj", width: null, height: null, themeable: false, warnings: [...new Set(warnings)].sort(), parts };
  }
  throw new Error("Workbench accepts PNG, JPEG, SVG, and geometry-only OBJ project assets.");
}

function validateSvg(source: string): void {
  const withoutComments = source.replaceAll(/<!--[^]*?-->/gu, "");
  if (/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b/iu.test(withoutComments)) throw new Error("SVG scripts, document types, entities, and foreignObject are not allowed.");
  if (/\son[a-z]+\s*=/iu.test(withoutComments)) throw new Error("SVG event handlers are not allowed.");
  if (/(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|data:)/iu.test(withoutComments) || /url\(\s*["']?\s*(?:https?:|\/\/|data:)/iu.test(withoutComments)) throw new Error("SVG assets cannot load external or embedded resources.");
}

function svgDimensions(source: string): { width: number; height: number } | null {
  const tag = /<svg\b([^>]*)>/iu.exec(source)?.[1] ?? "";
  const width = absoluteSvgNumber(attribute(tag, "width")), height = absoluteSvgNumber(attribute(tag, "height"));
  if (width && height) return { width, height };
  const viewBox = attribute(tag, "viewBox")?.trim().split(/[\s,]+/u).map(Number);
  return viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0 ? { width: viewBox[2], height: viewBox[3] } : null;
}

function attribute(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(tag)?.[1] ?? null;
}

function absoluteSvgNumber(value: string | null): number | null {
  if (!value || value.trim().endsWith("%")) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/iu.exec(value);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

function jpegDimensions(data: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return null;
}

function safeFilename(original: string, extension: string): string {
  const stem = basename(original, extname(original)).normalize("NFKD").replaceAll(/[^A-Za-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "").toLowerCase().slice(0, 64) || "asset";
  return `${stem}${extension}`;
}

function titleFromName(name: string): string {
  const stem = basename(name, extname(name));
  return stem.split(/[-_]+/u).filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ") || "Asset";
}

function tokens(name: string): string[] {
  return [...new Set(basename(name, extname(name)).toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean))];
}
