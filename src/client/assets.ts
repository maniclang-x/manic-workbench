import type { ManicAsset, ManicAssetPage, ManicAssetProvider, ManicAssetSearch, ResolvedManicAsset } from "@maniclang/scene";
import { apiRequest } from "./api";

/** Bind the host-neutral scene asset contract to Workbench's authenticated API. */
export function createWorkbenchAssetProvider(token: string): ManicAssetProvider {
  const resolved = new Map<string, Promise<ResolvedManicAsset | null>>();
  const metadata = new Map<string, ManicAsset>();

  return {
    async search(request: ManicAssetSearch): Promise<ManicAssetPage> {
      const query = new URLSearchParams({
        scope: request.scope,
        kind: request.kind ?? "all",
        query: request.query ?? "",
        limit: String(request.limit ?? 48),
      });
      if (request.cursor) query.set("cursor", request.cursor);
      const page = await apiRequest<ManicAssetPage>(token, `/api/assets?${query.toString()}`);
      for (const asset of page.assets) metadata.set(asset.uri, asset);
      return page;
    },

    resolve(uri: string): Promise<ResolvedManicAsset | null> {
      const cached = resolved.get(uri);
      if (cached) return cached;
      const request = resolveOne(token, uri, metadata.get(uri)).catch((error) => {
        resolved.delete(uri);
        throw error;
      });
      resolved.set(uri, request);
      return request;
    },

    async upload(file: File): Promise<ManicAsset> {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/assets/import", {
        method: "POST",
        headers: { "X-Manic-Session": token },
        body: form,
      });
      const body = await response.json() as { asset?: ManicAsset; error?: string };
      if (!response.ok || !body.asset) throw new Error(body.error ?? `Asset upload failed (${response.status}).`);
      metadata.set(body.asset.uri, body.asset);
      return body.asset;
    },
  };
}

async function resolveOne(token: string, uri: string, known?: ManicAsset): Promise<ResolvedManicAsset | null> {
  const metadata = known ?? (await apiRequest<{ asset: ManicAsset }>(token, `/api/assets/resolve?uri=${encodeURIComponent(uri)}`)).asset;
  const response = await fetch(`/api/assets/content?uri=${encodeURIComponent(uri)}`, {
    headers: { "X-Manic-Session": token },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Asset content failed (${response.status}).`);
  }
  const previewUrl = URL.createObjectURL(await response.blob());
  return { ...metadata, previewUrl };
}
