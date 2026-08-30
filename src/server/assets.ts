import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type {
  ManicAsset, ManicAssetKind, ManicAssetPage, ManicAssetScope, ManicSmartDrawImportMetadata,
} from "@maniclang/scene";
import type { WorkbenchSettings } from "./settings.js";
import { suggestAssetsDirFromEnginePath } from "./manicEnv.js";

const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const PROJECT_MANIFEST = ".manic/assets.json";
const PROJECT_ASSET_ROOT = ".manic/assets";
const projectMutationTails = new Map<string, Promise<void>>();

interface ProjectAssetRecord extends ManicAsset { createdAt: number; packageSha256?: string; }
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

/**
 * Install a relocatable Smart Draw package and let the engine create its
 * adjacent manifest before the package becomes visible in the project
 * catalogue. Any engine or catalogue failure rolls back the new directory.
 */
export async function importProjectSmartDraw(
  workspace: string,
  sourceFile: File,
  guideFile: File | null,
  prepare: (sourcePath: string, guidePath: string | null) => Promise<void>,
  metadata: ManicSmartDrawImportMetadata = {},
): Promise<ManicAsset> {
  return withProjectAssetMutation(workspace, () => importProjectSmartDrawUnlocked(workspace, sourceFile, guideFile, prepare, metadata));
}

async function importProjectSmartDrawUnlocked(
  workspace: string,
  sourceFile: File,
  guideFile: File | null,
  prepare: (sourcePath: string, guidePath: string | null) => Promise<void>,
  metadata: ManicSmartDrawImportMetadata,
): Promise<ManicAsset> {
  const source = await inspectUploadedFile(sourceFile);
  if (source.inspected.mediaType !== "image/svg+xml" && !(guideFile && source.inspected.mediaType === "image/png")) {
    throw new Error("Stroke Smart Draw needs an SVG. Filled SVG or PNG artwork also needs an SVG reveal guide.");
  }
  const guide = guideFile ? await inspectUploadedFile(guideFile) : null;
  if (guide && guide.inspected.mediaType !== "image/svg+xml") throw new Error("The Smart Draw reveal guide must be an SVG file.");

  const manifest = await readProjectManifest(workspace);
  const packageSha256 = smartDrawPackageSha256(source.bytes, guide?.bytes ?? null);
  const duplicate = manifest.assets.find((asset) => asset.kind === "smartdraw" && asset.packageSha256 === packageSha256);
  if (duplicate) return publicAsset(duplicate);

  const title = validateAssetTitle(metadata.title?.trim() || titleFromName(sourceFile.name));
  const collision = manifest.assets.find((asset) => asset.kind === "smartdraw" && asset.title.toLowerCase() === title.toLowerCase());
  if (collision) throw new Error(`A different Smart Draw package is already named “${title}”. Choose another title.`);
  const license = validateLicense(metadata.license);
  const provenance = validateProvenance(metadata, sourceFile.name);
  const id = randomUUID();
  const sourceName = safeFilename(sourceFile.name, source.inspected.extension);
  const guideName = guide ? uniqueGuideFilename(guideFile!.name, sourceName) : null;
  const relativePath = `project/${id}/${sourceName}`;
  const root = await ensureProjectAssetRoot(workspace);
  const directory = join(root, "project", id);
  await mkdir(directory, { mode: 0o700 });
  try {
    const sourcePath = join(directory, sourceName);
    const guidePath = guideName ? join(directory, guideName) : null;
    await writeFile(sourcePath, source.bytes, { flag: "wx", mode: 0o600 });
    if (guide && guidePath) await writeFile(guidePath, guide.bytes, { flag: "wx", mode: 0o600 });
    await prepare(sourcePath, guidePath);
    const manifestPath = sourcePath.slice(0, -extname(sourcePath).length) + ".draw";
    const manifestInformation = await lstat(manifestPath).catch(() => null);
    if (!manifestInformation?.isFile() || manifestInformation.isSymbolicLink()) {
      throw new Error("The Manic Engine did not create a safe adjacent .draw manifest.");
    }
    const manifestBytes = await readFile(manifestPath);

    const asset: ProjectAssetRecord = {
      uri: `asset:${relativePath}`,
      kind: "smartdraw",
      scope: "project",
      mediaType: source.inspected.mediaType,
      title,
      category: ["project", "smartdraw"],
      keywords: [...new Set([...tokens(sourceName), "smart", "draw"])],
      byteSize: source.bytes.length + (guide?.bytes.length ?? 0) + manifestBytes.length,
      sha256: source.sha256,
      ...(source.inspected.width && source.inspected.height ? {
        width: source.inspected.width,
        height: source.inspected.height,
        aspectRatio: Number((source.inspected.width / source.inspected.height).toFixed(6)),
      } : {}),
      themeable: source.inspected.themeable,
      license,
      ...(Object.keys(provenance).length ? { provenance } : {}),
      warnings: source.inspected.warnings,
      createdAt: Date.now(),
      packageSha256,
    };
    manifest.assets.push(asset);
    await writeProjectManifest(workspace, manifest);
    return publicAsset(asset);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Rename catalogue metadata without changing the immutable portable URI. */
export async function renameProjectSmartDraw(workspace: string, uri: string, titleValue: string): Promise<ManicAsset> {
  return withProjectAssetMutation(workspace, () => renameProjectSmartDrawUnlocked(workspace, uri, titleValue));
}

async function renameProjectSmartDrawUnlocked(workspace: string, uri: string, titleValue: string): Promise<ManicAsset> {
  const title = validateAssetTitle(titleValue);
  const manifest = await readProjectManifest(workspace);
  const asset = requireProjectSmartDrawRecord(manifest, uri);
  const collision = manifest.assets.find((candidate) => candidate.uri !== uri && candidate.kind === "smartdraw"
    && candidate.title.toLowerCase() === title.toLowerCase());
  if (collision) throw new Error(`A different Smart Draw package is already named “${title}”. Choose another title.`);
  asset.title = title;
  asset.keywords = [...new Set([...tokens(title), "smart", "draw"])];
  await writeProjectManifest(workspace, manifest);
  return publicAsset(asset);
}

/** Move the complete package to recoverable project trash, then unpublish it. */
export async function trashProjectSmartDraw(workspace: string, uri: string): Promise<ManicAsset> {
  return withProjectAssetMutation(workspace, () => trashProjectSmartDrawUnlocked(workspace, uri));
}

async function trashProjectSmartDrawUnlocked(workspace: string, uri: string): Promise<ManicAsset> {
  const manifest = await readProjectManifest(workspace);
  const asset = requireProjectSmartDrawRecord(manifest, uri);
  const root = await ensureProjectAssetRoot(workspace);
  const sourcePath = await safeExistingAsset(root, uri.slice("asset:".length));
  const directory = dirname(sourcePath);
  const packageId = basename(directory);
  const trashRoot = join(dirname(root), "trash", "assets");
  await mkdir(trashRoot, { recursive: true, mode: 0o700 });
  const trashDirectory = join(trashRoot, `${Date.now()}-${packageId}`);
  await rename(directory, trashDirectory);
  try {
    manifest.assets = manifest.assets.filter((candidate) => candidate.uri !== uri);
    await writeProjectManifest(workspace, manifest);
  } catch (error) {
    await rename(trashDirectory, directory);
    throw error;
  }
  return publicAsset(asset);
}

export interface SmartDrawPackageExport {
  filename: string;
  mediaType: "application/zip";
  bytes: Buffer;
}

/** Export only the registered source, adjacent manifest, and referenced guide. */
export async function exportProjectSmartDraw(workspace: string, uri: string): Promise<SmartDrawPackageExport> {
  const manifest = await readProjectManifest(workspace);
  const asset = requireProjectSmartDrawRecord(manifest, uri);
  const root = await ensureProjectAssetRoot(workspace);
  const sourcePath = await safeExistingAsset(root, uri.slice("asset:".length));
  const directory = dirname(sourcePath);
  const drawName = `${basename(sourcePath, extname(sourcePath))}.draw`;
  const drawPath = join(directory, drawName);
  const draw = await safePackageFile(directory, drawPath);
  const guideRef = /^\s*guide\s+(.+?)\s*$/mu.exec(draw.toString("utf8"))?.[1]?.trim() ?? null;
  const files: Array<{ name: string; data: Buffer }> = [
    { name: basename(sourcePath), data: await readFile(sourcePath) },
    { name: drawName, data: draw },
  ];
  if (guideRef) {
    if (guideRef.includes("\0") || guideRef.startsWith("/") || guideRef.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")) {
      throw new Error("The Smart Draw manifest references an unsafe reveal guide.");
    }
    const guidePath = join(directory, ...guideRef.split("/"));
    files.push({ name: guideRef, data: await safePackageFile(directory, guidePath) });
  }
  const metadata = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    asset: publicAsset(asset),
    packageSha256: asset.packageSha256 ?? null,
    files: files.map((file) => file.name),
  }, null, 2)}\n`, "utf8");
  files.push({ name: "manic-smartdraw-package.json", data: metadata });
  return {
    filename: `${safeFilename(asset.title, "").replace(/-$/u, "") || "smartdraw"}.manic-smartdraw.zip`,
    mediaType: "application/zip",
    bytes: zipStored(files),
  };
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
  try { await rename(temporary, target); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function withProjectAssetMutation<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const key = await realpath(workspace);
  const previous = projectMutationTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = previous.then(() => gate);
  projectMutationTails.set(key, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    await tail;
    if (projectMutationTails.get(key) === tail) projectMutationTails.delete(key);
  }
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
  const { createdAt: _createdAt, packageSha256: _packageSha256, ...result } = asset as ProjectAssetRecord;
  return result;
}

function requireProjectSmartDrawRecord(manifest: ProjectManifest, uri: string): ProjectAssetRecord {
  validateAssetUri(uri);
  if (!uri.startsWith("asset:project/")) throw new Error("Only project Smart Draw packages can be changed.");
  const asset = manifest.assets.find((candidate) => candidate.uri === uri);
  if (!asset || asset.kind !== "smartdraw") throw new Error(`Project Smart Draw package is not registered: ${uri}`);
  return asset;
}

function validateAssetTitle(value: string): string {
  const title = value.normalize("NFC").replaceAll(/\s+/gu, " ").trim();
  if (!title) throw new Error("A Smart Draw package title is required.");
  if (title.length > 120) throw new Error("Smart Draw package titles cannot exceed 120 characters.");
  if (/\p{Cc}/u.test(title)) throw new Error("The Smart Draw package title contains unsupported control characters.");
  return title;
}

function validateProvenance(metadata: ManicSmartDrawImportMetadata, importedFilename: string): NonNullable<ManicAsset["provenance"]> {
  const author = optionalText(metadata.author, 120, "Author");
  const sourceUrl = optionalWebUrl(metadata.sourceUrl, "Source URL");
  return {
    ...(author ? { author } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    importedFilename: basename(importedFilename),
  };
}

function validateLicense(value: ManicSmartDrawImportMetadata["license"]): ManicAsset["license"] {
  if (!value) return null;
  const id = optionalText(value.id, 80, "License ID");
  const name = optionalText(value.name, 120, "License name");
  const attribution = optionalText(value.attribution, 500, "Attribution");
  const url = optionalWebUrl(value.url, "License URL");
  if (!id && !name && !attribution && !url) return null;
  if (!id || !name) throw new Error("License ID and license name are both required when license metadata is supplied.");
  return {
    id,
    name,
    attributionRequired: value.attributionRequired === true,
    ...(attribution ? { attribution } : {}),
    ...(url ? { url } : {}),
  };
}

function optionalText(value: unknown, limit: number, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.normalize("NFC").replaceAll(/\s+/gu, " ").trim();
  if (!normalized) return null;
  if (normalized.length > limit) throw new Error(`${label} cannot exceed ${limit} characters.`);
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} contains unsupported control characters.`);
  return normalized;
}

function optionalWebUrl(value: unknown, label: string): string | null {
  const text = optionalText(value, 500, label);
  if (!text) return null;
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error(`${label} must be an absolute HTTP or HTTPS URL.`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label} must use HTTP or HTTPS.`);
  return parsed.toString();
}

function smartDrawPackageSha256(source: Buffer, guide: Buffer | null): string {
  const hash = createHash("sha256");
  hash.update("manic-smartdraw-package-v1\0source\0", "utf8");
  hash.update(source);
  hash.update("\0guide\0", "utf8");
  if (guide) hash.update(guide);
  return hash.digest("hex");
}

async function safePackageFile(directory: string, candidate: string): Promise<Buffer> {
  const canonicalDirectory = await realpath(directory);
  const information = await lstat(candidate).catch(() => null);
  if (!information?.isFile() || information.isSymbolicLink()) throw new Error(`Smart Draw package file is missing: ${basename(candidate)}`);
  const absolute = await realpath(candidate);
  const local = relative(canonicalDirectory, absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`)) throw new Error("Smart Draw package content escaped its package directory.");
  return readFile(absolute);
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

async function inspectUploadedFile(file: File) {
  if (!file.name || file.name.includes("\0")) throw new Error("The uploaded asset needs a filename.");
  if (file.size < 1) throw new Error("The uploaded asset is empty.");
  if (file.size > MAX_ASSET_BYTES) throw new Error("Project assets cannot exceed 16 MB.");
  const bytes = Buffer.from(await file.arrayBuffer());
  return {
    bytes,
    inspected: inspectAsset(file.name, bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function uniqueGuideFilename(original: string, sourceName: string): string {
  const candidate = safeFilename(original, ".svg");
  return candidate === sourceName ? "reveal-guide.svg" : candidate;
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

/** Minimal deterministic ZIP writer using stored entries; avoids a runtime archive dependency. */
function zipStored(files: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [], centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name.replaceAll("\\", "/"), "utf8");
    if (!name.length || file.name.startsWith("/") || file.name.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")) {
      throw new Error("A Smart Draw export entry has an unsafe name.");
    }
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01, the ZIP epoch.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + file.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
