// Workbench binding for the shared Manic scene editor (@maniclang/scene).
// The editor owns authoring + Manic code generation; Workbench owns files,
// autosave, and true engine preview via the configured manic binary.

import { SceneEditor } from "@maniclang/scene/react";
import "@maniclang/scene/editor.css";
// KaTeX styles for the canvas's equation sketch + the LaTeX field preview.
import "katex/dist/katex.min.css";
import { useMemo } from "react";
import { createWorkbenchAssetProvider } from "./assets";

export function VisualCanvas({ token, fileName, source, onApply, onOpenSource, onRevealSource, onPreview }: {
  token: string;
  fileName: string;
  source: string;
  onApply(source: string): void;
  onOpenSource(): void;
  onRevealSource(offset: number): void;
  onPreview(): void;
}) {
  const assetProvider = useMemo(() => createWorkbenchAssetProvider(token), [token]);
  return (
    <SceneEditor
      fileName={fileName}
      source={source}
      onSourceChange={onApply}
      onOpenSource={onOpenSource}
      onRevealSource={onRevealSource}
      onPreview={onPreview}
      assetProvider={assetProvider}
    />
  );
}
