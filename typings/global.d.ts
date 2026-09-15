/**
 * Build-time constants. `scripts/build.mjs` defines these through esbuild's
 * `define` option, which performs a literal text substitution — so they must
 * always be referenced as bare identifiers, never as object properties.
 *
 * `__env__` is declared here as well; use `import.meta.env`-style access via
 * `isDev` in `src/utils/env.ts` rather than touching it directly.
 */
declare const __env__: "development" | "production";

/**
 * `package.json` → `config.prefsPrefix`, e.g. `extensions.zotero.llmsummarizer`.
 *
 * The same value is applied to `addon/prefs.js` by the build, so injecting it
 * here keeps the two from drifting apart. Read it through `fullPrefKey()` in
 * `src/utils/prefs.ts`; the `typeof` guard there lets the self-test, which does
 * not define this constant, still run.
 */
declare const __prefsPrefix__: string;

/**
 * `package.json` → `version`, and the ISO timestamp of the build.
 *
 * Both are also substituted by `scripts/build.mjs`. They exist so a
 * hand-installed build can be told apart from a stale one: the manifest version
 * does not change between development iterations, so without the timestamp
 * there is no way to confirm a reinstall actually took effect. Read them through
 * `buildVersion` / `buildTime` in `src/utils/env.ts`.
 */
declare const __buildVersion__: string;
declare const __buildTime__: string;
