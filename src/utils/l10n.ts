/**
 * Fluent (`data-l10n-id` / `Localization`) formatting for plugin code.
 *
 * Zotero loads a plugin's `locale/<locale>/*.ftl` files and exposes them through
 * a *global* `Localization` constructor backed by the shared `zotero-plugins:`
 * L10n source — see `registerLocales()` in Zotero's `xpcom/plugins.js`. Passing
 * `true` as the second argument makes the bundle asynchronous and lets Fluent
 * fall back across locales, so the same call works in the plugin sandbox and in
 * a preferences window.
 *
 * The file name must match the `<html:link rel="localization">` href in
 * `content/preferences.xhtml` and the directory under `addon/locale/`.
 */
const addonRef = "llmsummarizer";
const bundlePath = `${addonRef}-preferences.ftl`;

/**
 * `formatValue()` resolves to a plain string (or `null`), but the plural
 * `formatMessages()` / `formatValues()` variants hand back an `L10nMessage`
 * *object* whose text lives on `.value`. Accept both so a change of call style
 * cannot silently stringify into `"[object Object]"`.
 */
type L10nMessage = { value?: unknown; attributes?: unknown };

type Bundle = { formatValue: (id: string) => Promise<unknown> } | null;

let bundle: Bundle | undefined;

function getBundle(): Bundle {
  if (bundle !== undefined) {
    return bundle;
  }
  try {
    // Injected into the plugin sandbox by Zotero; absent outside Zotero.
    const LocalizationCtor = (globalThis as { Localization?: new (ids: string[], sync: boolean) => unknown })
      .Localization;
    bundle = LocalizationCtor
      ? (new LocalizationCtor([bundlePath], true) as Bundle)
      : null;
  } catch {
    bundle = null;
  }
  return bundle;
}

/**
 * Formats a Fluent message, or returns `fallback` when the bundle or message is
 * unavailable — a locale gap should degrade to readable text, not a raw id.
 *
 * `formatValue()` is used rather than `formatMessages()` because the latter
 * always resolves to `L10nMessage` objects. Returning one of those to a caller
 * that assigns it to `textContent` renders **`[object Object]`** — which is
 * exactly what every label in the preferences pane did before this was fixed.
 * Zotero's own code reads `.value` for the same reason (see `formatMessages`
 * handling in `chrome/content/zotero/preferences/preferences.js`).
 */
export async function getString(id: string, fallback: string): Promise<string> {
  const active = getBundle();
  if (!active) {
    return fallback;
  }
  try {
    const result = await active.formatValue(id);
    if (typeof result === "string" && result) {
      return result;
    }
    // Defensive: tolerate an `L10nMessage` if the platform ever hands one back.
    const value = (result as L10nMessage | null)?.value;
    if (typeof value === "string" && value) {
      return value;
    }
    return fallback;
  } catch {
    return fallback;
  }
}
