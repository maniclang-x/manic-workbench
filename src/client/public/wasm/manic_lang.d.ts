/* tslint:disable */
/* eslint-disable */

/**
 * Deterministic auto-correct — returns `{"code":"…","fixed":N}`. This is the SAME
 * Rust logic behind the `manic fix` CLI (`crate::autofix`), so the browser playground
 * can call it instead of maintaining its own copy. `include_removals` applies
 * destructive stray-token removals (the 🔧 Auto-fix button behaviour; `false` = the
 * silent post-AI pass); `wrap_latex` runs the bare `equation`/`rewrite` LaTeX normalizer.
 * The whole multi-pass loop runs in Rust — no per-pass JS↔WASM `check()` round-trips.
 */
export function autofix(src: string, include_removals: boolean, wrap_latex: boolean): string;

/**
 * Diagnostics — `[{start,len,severity,message,fix?}]`.
 */
export function check(src: string): string;

/**
 * Completions at a char `offset` — `[{label,kind,insert,detail,doc}]`.
 */
export function complete(src: string, offset: number): string;

/**
 * Semantic tokens for highlighting — `[{start,len,kind}]`.
 */
export function tokenize(src: string): string;

/**
 * Voice / TTS cost report — JSON with provider, model, characters, words, and
 * estimated Cartesia credits (no network; parse + expand only).
 *
 * Shape:
 * `{present,provider,model,voice,voice_id,tone,language,lines,characters,words,est_credits,cost_note,cues:[{text,characters,words}]}`
 */
export function voice_report(src: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly autofix: (a: number, b: number, c: number, d: number) => [number, number];
    readonly check: (a: number, b: number) => [number, number];
    readonly complete: (a: number, b: number, c: number) => [number, number];
    readonly tokenize: (a: number, b: number) => [number, number];
    readonly voice_report: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
