import { getBoolPref } from "./prefs";

/**
 * Build metadata injected by esbuild's `define` (see `scripts/build.mjs`).
 *
 * `__env__` is substituted at build time, so it must be read as a bare
 * identifier — `{ __env__ }` destructuring would break the substitution and
 * leave an undefined reference in the bundle.
 */
export const env: "development" | "production" =
  typeof __env__ === "undefined" ? "production" : __env__;

export const isDev = env === "development";

/**
 * Build identity, also injected by esbuild's `define`.
 *
 * The `typeof` guards mirror the one above: a bundler that does not run
 * `scripts/build.mjs` (the self-test) leaves these undefined, and substituting a
 * plain identifier would throw a ReferenceError rather than fall back.
 */
export const buildVersion: string =
  typeof __buildVersion__ === "undefined" ? "dev" : __buildVersion__;
export const buildTime: string =
  typeof __buildTime__ === "undefined" ? "unknown" : __buildTime__;

/**
 * Whether to expand the extra arguments passed to `log()`.
 *
 * The one-line message always goes to the debug output (Zotero's own logging
 * prefs decide what is actually shown); this only controls the verbose dump of
 * attached objects, which is what the pane's "输出调试日志" toggle turns on.
 */
function verbose(): boolean {
  return isDev || getBoolPref("debug");
}

/** Prefixed so plugin output is filterable in the Help → Debug Output log. */
export function log(message: string, ...args: unknown[]): void {
  Zotero.debug(`[LLMSummarizer] ${message}`);
  if (args.length && verbose()) {
    Zotero.debug(args.map((a) => safeStringify(a)).join(" "));
  }
}

export function logError(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  Zotero.debug(`[LLMSummarizer] ERROR: ${safeStringify(error)}`);
}

/** `JSON.stringify` throws on circular structures — never let logging do that. */
export function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
