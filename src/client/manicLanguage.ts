import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";

export interface ManicDiagnostic {
  start: number;
  len: number;
  severity: "warning" | "error";
  message: string;
  fix?: { start: number; len: number; replacement: string; label?: string };
}

interface ManicCompletion { label: string; kind: string; insert: string; detail?: string; doc?: string; }
interface ManicToken { start: number; len: number; kind: string; }
interface ManicWasmModule {
  default(input?: unknown): Promise<unknown>;
  check(source: string): string;
  tokenize(source: string): string;
  complete(source: string, offset: number): string;
  autofix(source: string, includeRemovals: boolean, wrapLatex: boolean): string;
}

export interface ManicLanguageService {
  check(source: string): ManicDiagnostic[];
  autofix(source: string): { code: string; fixed: number };
}

let servicePromise: Promise<ManicLanguageService> | null = null;

export function loadManicLanguage(monaco: typeof Monaco): Promise<ManicLanguageService> {
  servicePromise ??= initialize(monaco);
  return servicePromise;
}

async function initialize(monaco: typeof Monaco): Promise<ManicLanguageService> {
  const moduleUrl = "/wasm/manic_lang.js";
  const wasm = await import(/* @vite-ignore */ moduleUrl) as ManicWasmModule;
  await wasm.default();

  const tokenTypes = ["builtin", "keyword", "constant", "color", "ease", "number", "string", "variable", "comment"];
  monaco.languages.registerDocumentSemanticTokensProvider("manic", {
    getLegend: () => ({ tokenTypes, tokenModifiers: [] }),
    provideDocumentSemanticTokens(model) {
      const raw = parseJson<ManicToken[]>(wasm.tokenize(model.getValue()), []);
      const tokens = raw
        .map((token) => ({ token, position: model.getPositionAt(token.start) }))
        .filter(({ token, position }) => model.getPositionAt(token.start + Math.max(1, token.len)).lineNumber === position.lineNumber)
        .sort((a, b) => a.token.start - b.token.start);
      const data: number[] = [];
      let previousLine = 0;
      let previousColumn = 0;
      for (const { token, position } of tokens) {
        const line = position.lineNumber - 1;
        const column = position.column - 1;
        const deltaLine = line - previousLine;
        data.push(deltaLine, deltaLine === 0 ? column - previousColumn : column, Math.max(1, token.len), Math.max(0, tokenTypes.indexOf(normalizeToken(token.kind))), 0);
        previousLine = line;
        previousColumn = column;
      }
      return { data: new Uint32Array(data) };
    },
    releaseDocumentSemanticTokens() {},
  });

  monaco.languages.registerCompletionItemProvider("manic", {
    triggerCharacters: ["(", ",", " ", ".", '"'],
    provideCompletionItems(model, position) {
      const offset = model.getOffsetAt(position);
      const items = parseJson<ManicCompletion[]>(wasm.complete(model.getValue(), offset), []);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: items.map((item) => ({
          label: item.label,
          kind: completionKind(monaco, item.kind),
          insertText: item.insert,
          detail: item.detail,
          documentation: item.doc,
          range,
        })),
      };
    },
  });

  return {
    check: (source) => parseJson<ManicDiagnostic[]>(wasm.check(source), []),
    autofix: (source) => parseJson(wasm.autofix(source, true, true), { code: source, fixed: 0 }),
  };
}

function normalizeToken(kind: string): string {
  if (kind === "call") return "builtin";
  return tokenKindSet.has(kind) ? kind : "variable";
}

const tokenKindSet = new Set(["builtin", "keyword", "constant", "color", "ease", "number", "string", "variable", "comment"]);

function completionKind(monaco: typeof Monaco, kind: string): Monaco.languages.CompletionItemKind {
  if (kind === "function" || kind === "builtin") return monaco.languages.CompletionItemKind.Function;
  if (kind === "keyword") return monaco.languages.CompletionItemKind.Keyword;
  if (kind === "color" || kind === "constant") return monaco.languages.CompletionItemKind.Constant;
  return monaco.languages.CompletionItemKind.Variable;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
