/**
 * Self-test for the plugin's pure logic.
 *
 * The Zotero-dependent parts (item tree, notes, network) can only be exercised
 * inside a running Zotero, but the text pipeline — Markdown conversion, length
 * truncation, prompt assembly, URL normalisation — is pure and is where most
 * regressions would hide. This harness stubs the small slice of the `Zotero`
 * global those modules touch and asserts real behaviour.
 *
 * Run with: npm test
 */
import { readFileSync } from "node:fs";
import { cleanText, truncateSmart } from "../src/modules/textExtractor";
import { buildChatCompletionsUrl } from "../src/modules/llmClient";
import { escapeHtml, markdownToNoteHTML, renderInline } from "../src/modules/markdown";
import { buildPromptContext, renderPrompt } from "../src/modules/promptLibrary";
import { getString } from "../src/utils/l10n";
import { TimeoutError, createAbortController, withTimeout } from "../src/utils/abort";
import { MenuManager } from "../src/modules/menuManager";
import { resolveNoteTarget } from "../src/modules/noteManager";
import {
  PREF_KEYS,
  fullPrefKey,
  getNumberPref,
  getPref,
  getPromptTemplates,
  setPref,
  type PromptTemplate,
} from "../src/utils/prefs";

// ---------------------------------------------------------------- Zotero stub

const errors: unknown[] = [];

/** Records every pref key touched, so pref-name mistakes are caught here. */
const prefsRead: string[] = [];
const prefsWritten: string[] = [];

(globalThis as Record<string, unknown>).Zotero = {
  debug: () => {},
  warn: () => {},
  logError: (e: unknown) => errors.push(e),
  Prefs: {
    // Returning undefined makes src/utils/prefs.ts fall back to its defaults.
    get: (key: string) => {
      prefsRead.push(key);
      return undefined;
    },
    set: (key: string) => {
      prefsWritten.push(key);
    },
  },
  Items: { get: () => false },
  Item: class {},
};

// ------------------------------------------------------------------- harness

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

function checkEqual(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    Object.is(actual, expected),
    `expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
  );
}

function checkIncludes(name: string, haystack: string, needle: string): void {
  check(name, haystack.includes(needle), `looking for ${JSON.stringify(needle)} in:\n      ${haystack}`);
}

// ------------------------------------------------------------------- markdown

{
  const html = markdownToNoteHTML("# Title\n\nHello world.\n\n- one\n- two");
  checkIncludes("h1 rendered", html, "<h1>Title</h1>");
  checkIncludes("paragraph rendered", html, "<p>Hello world.</p>");
  checkIncludes("unordered list rendered", html, "<ul><li>one</li><li>two</li></ul>");
}

{
  const html = markdownToNoteHTML("1. first\n2. second");
  checkIncludes("ordered list rendered", html, "<ol><li>first</li><li>second</li></ol>");
}

{
  // Indent-based nesting is what every LLM emits for sub-points.
  const html = markdownToNoteHTML("- parent\n  - child\n  - child2\n- parent2");
  checkIncludes(
    "nested list rendered",
    html,
    "<ul><li>parent<ul><li>child</li><li>child2</li></ul></li><li>parent2</li></ul>",
  );
}

{
  // Regression: a bullet list nested under a *numbered* item must stay a bullet
  // list. The nested tag comes from the child markers, not from the parent item.
  const html = markdownToNoteHTML("1. step one\n   - detail a\n   - detail b\n2. step two");
  checkIncludes(
    "bullet children of an ordered item stay bullets",
    html,
    "<ol><li>step one<ul><li>detail a</li><li>detail b</li></ul></li><li>step two</li></ol>",
  );
}

{
  // The mirror case: numbered children under a bullet item.
  const html = markdownToNoteHTML("- note\n  1. first\n  2. second");
  checkIncludes(
    "numbered children of a bullet item stay numbered",
    html,
    "<ul><li>note<ol><li>first</li><li>second</li></ol></li></ul>",
  );
}

{
  // Two sibling lists of different kinds must not merge into one.
  const html = markdownToNoteHTML("- bullet\n\n1. one\n2. two");
  checkIncludes("sibling bullet list", html, "<ul><li>bullet</li></ul>");
  checkIncludes("sibling ordered list", html, "<ol><li>one</li><li>two</li></ol>");
}

{
  const html = markdownToNoteHTML("**bold** and *italic* and `code` and ~~gone~~");
  checkIncludes("strong", html, "<strong>bold</strong>");
  checkIncludes("emphasis", html, "<em>italic</em>");
  checkIncludes("code span", html, "<code>code</code>");
  checkIncludes("strikethrough", html, "<del>gone</del>");
}

{
  const html = markdownToNoteHTML("__bold__ and _italic_");
  checkIncludes("underscore strong", html, "<strong>bold</strong>");
  checkIncludes("underscore emphasis", html, "<em>italic</em>");
}

{
  // A code span must protect its contents from the emphasis rules.
  const html = markdownToNoteHTML("`a *b* _c_`");
  checkIncludes("code span is literal", html, "<code>a *b* _c_</code>");
}

{
  const html = markdownToNoteHTML("[paper](https://example.com/x)");
  checkIncludes("link rendered", html, '<a href="https://example.com/x">paper</a>');
}

{
  // Injected markup in model output must never reach the note as live HTML.
  const html = markdownToNoteHTML('<script>alert("xss")</script> & "quoted"');
  check("script tag escaped", !html.includes("<script>"), html);
  checkIncludes("angle brackets escaped", html, "&lt;script&gt;");
  checkIncludes("ampersand escaped", html, "&amp;");
}

{
  const html = markdownToNoteHTML("[click](javascript:alert(1))");
  check("javascript: link dropped", !html.includes("javascript:"), html);
  checkIncludes("javascript: link text kept", html, "click");
}

{
  const html = markdownToNoteHTML("```js\nconst a = 1 < 2;\n```");
  checkIncludes("fenced code block", html, '<pre><code class="language-js">');
  checkIncludes("code block escaped", html, "1 &lt; 2");
}

{
  const html = markdownToNoteHTML("| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |");
  checkIncludes("table head", html, "<th>Name</th>");
  checkIncludes("table cell", html, "<td>1</td>");
  checkIncludes("table row count", html, "<tbody>");
}

{
  const html = markdownToNoteHTML("> quoted line");
  checkIncludes("blockquote", html, "<blockquote><p>quoted line</p></blockquote>");
}

{
  const html = markdownToNoteHTML("---");
  checkIncludes("horizontal rule", html, "<hr>");
}

{
  // Zotero derives the note title from the first heading in the body, so the
  // supplied title must always come first — see noteManager.createSummaryNote().
  const html = markdownToNoteHTML("Just prose, no heading.", "通用研读总结");
  check("title prepended when missing", html.startsWith("<h1>通用研读总结</h1>"));

  const withHeading = markdownToNoteHTML("# Model heading\n\nbody", "模板名");
  check("supplied title takes the note title", withHeading.startsWith("<h1>模板名</h1>"));
  checkIncludes("model heading demoted", withHeading, "<h2>Model heading</h2>");
  check("demoted heading is the only h1", (withHeading.match(/<h1>/g) ?? []).length === 1);

  // The title is HTML-escaped, so a template name with markup cannot inject tags.
  const escaped = markdownToNoteHTML("body", 'A & B <b>"c"</b>');
  check(
    "title is escaped",
    escaped.startsWith("<h1>A &amp; B &lt;b&gt;&quot;c&quot;&lt;/b&gt;</h1>"),
    escaped.slice(0, 60),
  );

  // No title given: the document is passed through untouched.
  checkEqual("no title leaves the document alone", markdownToNoteHTML("# H\n\nbody"), "<h1>H</h1>\n<p>body</p>");
}

{
  checkEqual("escapeHtml", escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  checkEqual("renderInline plain", renderInline("no markup"), "no markup");
  checkEqual("renderInline newline to break", renderInline("a\nb"), "a<br>b");
}

// ----------------------------------------------------------------- truncation

{
  const short = "x".repeat(500);
  const result = truncateSmart(short, 1000);
  checkEqual("short text untouched", result.text, short);
  check("short text not marked truncated", !result.truncated);
}

{
  const head = "H".repeat(3000);
  const tail = "T".repeat(2000);
  const result = truncateSmart(head + tail, 1000);

  check("long text marked truncated", result.truncated);
  check(
    "result respects the character budget",
    result.text.length <= 1000,
    `got ${result.text.length}`,
  );
  checkIncludes("omission marker present", result.text, "省略");
  check("keeps the head", result.text.startsWith("H"));
  check("keeps the tail", result.text.endsWith("T"));

  const headCount = (result.text.match(/H/g) ?? []).length;
  const tailCount = (result.text.match(/T/g) ?? []).length;

  // Every character is accounted for: kept characters plus the reported
  // omission must equal the original length.
  checkEqual("omitted count is consistent", result.omittedChars, 5000 - headCount - tailCount);

  // The specification is a 60/40 split of the usable budget.
  const ratio = headCount / (headCount + tailCount);
  check(
    "head/tail split is 60/40",
    Math.abs(ratio - 0.6) < 0.005,
    `ratio=${ratio.toFixed(4)} head=${headCount} tail=${tailCount}`,
  );
}

{
  // Exact boundary: text at exactly the limit must pass through untouched.
  const exact = "y".repeat(1000);
  const result = truncateSmart(exact, 1000);
  checkEqual("exact-limit text untouched", result.text, exact);
  check("exact-limit text not truncated", !result.truncated);
}

// ------------------------------------------------------------------ cleanText

{
  checkEqual(
    "de-hyphenates line breaks",
    cleanText("infor-\nmation"),
    "information",
  );
  checkEqual("collapses runs of spaces", cleanText("a    b"), "a b");
  checkEqual("collapses blank lines", cleanText("a\n\n\n\n\nb"), "a\n\nb");
  checkEqual("empty input", cleanText(undefined), "");
}

// -------------------------------------------------------------- llmClient URL

{
  checkEqual(
    "base url without path",
    buildChatCompletionsUrl("https://api.deepseek.com"),
    "https://api.deepseek.com/chat/completions",
  );
  checkEqual(
    "base url with /v1",
    buildChatCompletionsUrl("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/v1/chat/completions",
  );
  checkEqual(
    "base url with trailing slash",
    buildChatCompletionsUrl("http://localhost:11434/v1/"),
    "http://localhost:11434/v1/chat/completions",
  );
  checkEqual(
    "full endpoint left alone",
    buildChatCompletionsUrl("https://x.test/v1/chat/completions"),
    "https://x.test/v1/chat/completions",
  );

  let threw = false;
  try {
    buildChatCompletionsUrl("");
  } catch {
    threw = true;
  }
  check("empty base url throws", threw);
}

// --------------------------------------------------------------- prompt render

{
  const template: PromptTemplate = {
    id: "t",
    name: "t",
    prompt: "Title: {{title}}\nAuthors: {{creators}}\n\n{{content}}",
  };
  const context = {
    content: "PAPER BODY",
    title: "A Study",
    creators: "Alice, Bob",
    year: "2024",
    publication: "Nature",
    date: "2024-01-01",
    itemType: "journalArticle",
  };

  const prompt = renderPrompt(template, context);
  checkIncludes("title substituted", prompt, "A Study");
  checkIncludes("creators substituted", prompt, "Alice, Bob");
  checkIncludes("content substituted", prompt, "PAPER BODY");
  check("no placeholders left", !prompt.includes("{{"), prompt);
}

{
  // An unknown placeholder must survive visibly rather than silently blanking.
  const template: PromptTemplate = { id: "t", name: "t", prompt: "X {{typo}} Y {{content}}" };
  const prompt = renderPrompt(template, {
    content: "BODY",
    title: "",
    creators: "",
    year: "",
    publication: "",
    date: "",
    itemType: "",
  });
  checkIncludes("unknown placeholder preserved", prompt, "{{typo}}");
}

{
  // Paper text containing placeholder syntax must not be re-substituted.
  const template: PromptTemplate = { id: "t", name: "t", prompt: "{{title}} :: {{content}}" };
  const prompt = renderPrompt(template, {
    content: "the token {{title}} appears literally in this paper",
    title: "REAL TITLE",
    creators: "",
    year: "",
    publication: "",
    date: "",
    itemType: "",
  });
  checkIncludes("content injected verbatim", prompt, "{{title}} appears literally");
  check(
    "injected content did not leak into the title slot",
    prompt.startsWith("REAL TITLE ::"),
    prompt.slice(0, 60),
  );
}

{
  // A template missing the content slot still has to receive the paper.
  const template: PromptTemplate = { id: "t", name: "t", prompt: "Summarise this." };
  const prompt = renderPrompt(template, {
    content: "BODY",
    title: "",
    creators: "",
    year: "",
    publication: "",
    date: "",
    itemType: "",
  });
  checkIncludes("content appended when slot missing", prompt, "BODY");
}

{
  const template: PromptTemplate = { id: "t", name: "t", prompt: "{{content}}" };
  const prompt = renderPrompt(template, {
    content: "BODY",
    title: "",
    creators: "",
    year: "",
    publication: "",
    date: "",
    itemType: "",
    truncated: true,
  });
  checkIncludes("truncation notice added", prompt, "省略");
}

// ------------------------------------------------------------------ pref keys

{
  // Regression: `Zotero.Prefs.get(name, true)` treats `name` as fully
  // qualified. Passing a short name with `global = true` silently reads a
  // root-level pref (`apiBaseUrl`) instead of the plugin's, and every value
  // falls back to its default — the plugin appears configured but is not.
  //
  // The prefix is read from package.json rather than hardcoded: the build
  // injects it via `define`, and this run deliberately does not, so comparing
  // against the real config is what catches the fallback literal drifting.
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { config: { prefsPrefix: string } };
  const PREFIX = pkg.config.prefsPrefix;

  checkEqual("fullPrefKey prefixes the key", fullPrefKey("apiBaseUrl"), `${PREFIX}.apiBaseUrl`);

  prefsRead.length = 0;
  getPref("modelName");
  checkEqual("getPref reads the fully-qualified key", prefsRead[0], `${PREFIX}.modelName`);

  prefsWritten.length = 0;
  setPref("debug", true);
  checkEqual("setPref writes the fully-qualified key", prefsWritten[0], `${PREFIX}.debug`);

  prefsRead.length = 0;
  getPromptTemplates();
  checkEqual(
    "getPromptTemplates reads the fully-qualified key",
    prefsRead[0],
    `${PREFIX}.promptTemplates`,
  );

  // Every logical key must round-trip under the same prefix.
  for (const key of Object.values(PREF_KEYS)) {
    checkEqual(`fullPrefKey(${key})`, fullPrefKey(key), `${PREFIX}.${key}`);
  }

  // Gecko prefs are typed bool/int/string with no float type, and
  // `setDefaultPrefs()` sends a JS number to `setIntPref()`. A numeric default
  // for temperature would therefore be truncated to 0 — the same silent-wrong-
  // value class of bug as the prefix above, but invisible in the UI.
  const defaults: string = readFileSync(
    new URL("../addon/prefs.js", import.meta.url),
    "utf8",
  );
  const temperatureLiteral = /^pref\(\s*"temperature"\s*,\s*(.+?)\s*\)/m.exec(defaults)?.[1] ?? "";
  check(
    "prefs.js declares temperature as a quoted string",
    /^"/.test(temperatureLiteral),
    `found: pref("temperature", ${temperatureLiteral})`,
  );
  check(
    "temperature default parses to a usable value",
    Number(temperatureLiteral.replace(/"/g, "")) > 0,
    `parsed: ${Number(temperatureLiteral.replace(/"/g, ""))}`,
  );

  // The runtime fallback (used when the pref is unset) must agree with the
  // declared default, since the stub makes every read return undefined.
  const fallbackTemperature = getPref("temperature");
  checkEqual("fallback temperature is a string", typeof fallbackTemperature, "string");
  checkEqual("fallback matches the declared default", fallbackTemperature, "0.3");
  checkEqual(
    "temperature survives a numeric round-trip",
    getNumberPref("temperature", 0, 2),
    0.3,
  );
}

// ----------------------------------------------------------- addon manifest

{
  // Zotero patches the toolkit's `Extension.sys.mjs` to require four keys under
  // `applications.zotero`. A missing one is reported through `manifestError()`
  // → `packagingError()`, which merely appends to the extension's `errors`
  // array; the throw happens later, in `loadManifest()` → `ensureNoErrors()`.
  // The plugin then never loads at all, and the Add-ons window explains nothing.
  //
  // `update_url` is the trap here: it reads like an optional convenience for
  // publishing updates, but its absence is fatal.
  const manifestRaw = readFileSync(new URL("../addon/manifest.json", import.meta.url), "utf8");
  const manifest = JSON.parse(manifestRaw) as {
    applications?: { zotero?: Record<string, unknown> };
  };
  const zotero = manifest.applications?.zotero ?? {};

  for (const key of ["id", "update_url", "strict_min_version", "strict_max_version"]) {
    const value = zotero[key];
    check(
      `manifest declares applications.zotero.${key}`,
      typeof value === "string" && value.length > 0,
      `got: ${JSON.stringify(value)}`,
    );
  }

  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { config: { updateURL: string; strictMaxVersion: string } };

  // The two manifest values are build-time tokens, so they must have a source.
  checkEqual("update_url is fed from config.updateURL", zotero.update_url, "__updateURL__");
  checkEqual(
    "strict_max_version is fed from config.strictMaxVersion",
    zotero.strict_max_version,
    "__strictMaxVersion__",
  );

  // `update_url` must be an absolute URL: the manifest schema types it as
  // `format: url`, and a relative value fails validation at install time.
  let updateUrl: URL | null = null;
  try {
    updateUrl = new URL(pkg.config.updateURL);
  } catch {
    /* left null; asserted below */
  }
  check(
    "config.updateURL is an absolute URL",
    updateUrl !== null && updateUrl.protocol === "https:",
    `got: ${pkg.config.updateURL}`,
  );

  // Regression: this was `7.*`, which Zotero compares against its own app
  // version. Zotero's `AddonManager` initialises `gStrictCompatibility = true`,
  // so unlike stock Firefox it *does* enforce maxVersion — `7.*` therefore
  // reports the plugin as incompatible on anything newer and it is never
  // activated. Unbounded is also what Zotero assumes when `strict_max_version`
  // is absent (`app.maxVersion || "*"`), so `*` is the semantics-preserving way
  // to satisfy the validator that demands the key exist.
  checkEqual("strict_max_version is unbounded", pkg.config.strictMaxVersion, "*");
}

// ------------------------------------------------------------------------ l10n

{
  // Regression: the pane rendered "[object Object]" for every label because
  // `getString` returned whatever `formatMessages()` gave it — and that method
  // resolves to `L10nMessage` objects, not strings. Assigning one to
  // `textContent` stringifies it. The fix calls `formatValue()` (which yields a
  // plain string) and additionally unwraps `.value` defensively.
  //
  // The stub returns both shapes so a future switch back to `formatMessages`
  // is caught here instead of in the UI.
  (globalThis as Record<string, unknown>).Localization = class {
    formatValue(id: string): Promise<unknown> {
      switch (id) {
        case "str-message":
          return Promise.resolve("字符串消息");
        case "obj-message":
          // What `formatMessages()` / `formatValues()` return.
          return Promise.resolve({ value: "对象消息", attributes: [] });
        default:
          return Promise.resolve(null);
      }
    }
  };

  checkEqual("plain string message is returned as-is", await getString("str-message", "fb"), "字符串消息");

  const unwrapped = await getString("obj-message", "fb");
  checkEqual("L10nMessage is unwrapped to its value", unwrapped, "对象消息");
  check(
    "L10nMessage never stringifies to [object Object]",
    !String(unwrapped).includes("[object Object]"),
    `got: ${unwrapped}`,
  );

  checkEqual("missing message falls back", await getString("absent", "回退文案"), "回退文案");
}

// ------------------------------------------------- Zotero-specific API shapes

{
  // Regression: `buildPromptContext` called `meta.getItemType()`, which does not
  // exist — `itemType` is a getter (`Zotero.defineProperty(Zotero.Item.prototype,
  // 'itemType', …)`). Because our own typings had invented the method, `tsc`
  // accepted the call and it only failed inside Zotero as
  // "TypeError: getItemType is not a function", silently blanking the item type
  // in every prompt.
  //
  // The stub below therefore has the getter and deliberately no `getItemType`;
  // reverting the source makes the value come back empty and this fails.
  const stubItem = {
    isAttachment: () => false,
    parentItemID: false,
    getCreators: () => [{ firstName: "Ada", lastName: "Lovelace" }],
    getField: (field: string) => (field === "date" ? "2024" : field === "title" ? "A Study" : ""),
    getDisplayTitle: () => "A Study",
    itemType: "journalArticle",
  } as unknown as ZoteroItem;

  const context = buildPromptContext(stubItem, "body text");

  checkEqual("item type is read from the itemType getter", context.itemType, "journalArticle");
  checkEqual("title is collected", context.title, "A Study");
  checkEqual("creators are joined", context.creators, "Ada Lovelace");
  checkEqual("year falls back to date", context.year, "2024");
  checkEqual("content is passed through", context.content, "body text");
  check(
    "no field lookup failures for a well-formed item",
    context.itemType !== "" && context.creators !== "未知",
    `itemType=${JSON.stringify(context.itemType)} creators=${JSON.stringify(context.creators)}`,
  );
}

{
  // The Zotero plugin sandbox exposes `fetch` but not `AbortController`
  // (`xpcom/plugins.js` → `_loadScope()`'s `wantGlobalProperties` allow-list), so
  // `new AbortController()` throws ReferenceError and every summarise action dies
  // before sending a request.
  //
  // The fallback order matters and is easy to get backwards: Zotero's own comment
  // at `plugins.js:502` says the main window is the one you always have on
  // non-macOS and the *hidden* window the one you always have on macOS. On
  // Windows and Linux, reading `Services.appShell.hiddenDOMWindow` throws
  // NS_ERROR_FAILURE — which is how an earlier version of this file shipped a
  // fix that still crashed on the reporter's machine.
  //
  // Hiding the Node global reproduces the sandbox condition, so these exercise
  // the real Zotero paths rather than the branch that only ever runs here.
  const scope = globalThis as Record<string, unknown>;
  const savedAbort = scope.AbortController;
  const savedServices = scope.Services;
  const savedZotero = scope.Zotero;

  try {
    scope.AbortController = undefined;

    // (a) A main window is available — the Windows/Linux case. This must be
    //     taken *without* consulting the hidden window, which throws there.
    let hiddenWindowRead = false;
    scope.Zotero = {
      getMainWindow: () => ({ AbortController: savedAbort }),
      debug: () => {},
      warn: () => {},
    };
    scope.Services = {
      appShell: {
        get hiddenDOMWindow() {
          hiddenWindowRead = true;
          throw new Error("NS_ERROR_FAILURE");
        },
      },
    };

    const controller = createAbortController();
    check(
      "borrows AbortController from the main window",
      typeof controller?.abort === "function" && Boolean(controller.signal),
      `got: ${String(controller)}`,
    );
    check(
      "does not touch hiddenDOMWindow when a main window exists",
      !hiddenWindowRead,
      "hiddenDOMWindow was read even though getMainWindow() returned a window",
    );

    let aborted = false;
    controller?.signal.addEventListener("abort", () => {
      aborted = true;
    });
    controller?.abort();
    check("the borrowed controller actually aborts", aborted);

    // (b) No window at all, and hiddenDOMWindow throwing exactly as it does on
    //     Windows. `createAbortController` must report "none", not throw: the
    //     timeout still has to fire.
    scope.Zotero = { getMainWindow: () => null, debug: () => {}, warn: () => {} };
    check(
      "returns null instead of throwing when no window can supply a controller",
      createAbortController() === null,
      `got: ${String(createAbortController())}`,
    );

    // (c) The timeout is the part the user experiences, so it must work with no
    //     AbortController anywhere in sight.
    const started = Date.now();
    let timedOut = false;
    await withTimeout(() => new Promise(() => {}), 30).then(
      () => {},
      (e: unknown) => {
        timedOut = e instanceof TimeoutError;
      },
    );
    check(
      "withTimeout still rejects with TimeoutError when no AbortController exists",
      timedOut,
      `timedOut=${timedOut} elapsed=${Date.now() - started}ms`,
    );

    // (d) ...and must not fire early when the work finishes in time.
    const fast = await withTimeout(() => Promise.resolve("done"), 5_000);
    check("withTimeout resolves normally when the work beats the clock", fast === "done");

    // (e) A synchronous throw from `run` must surface as a rejection, not escape
    //     past the race and leave the timer armed.
    let escaped = false;
    await withTimeout(() => {
      throw new Error("boom");
    }, 5_000).then(
      () => {},
      (e: unknown) => {
        escaped = e instanceof Error && e.message === "boom";
      },
    );
    check("a synchronous throw inside withTimeout becomes a rejection", escaped);
  } finally {
    scope.AbortController = savedAbort;
    scope.Services = savedServices;
    scope.Zotero = savedZotero;
  }

  check(
    "the Node global still wins when it exists (self-test path)",
    typeof createAbortController()?.abort === "function",
  );
}

// ------------------------------------------------------------------ item menu

{
  // Regression: hovering the submenu made it flicker and never open, because
  // `popupshowing` bubbles. Opening the submenu fired the event again on the
  // child `menupopup`, it bubbled to `#zotero-itemmenu`, and the handler deleted
  // the element the user was hovering.
  //
  // The stub below is just enough DOM for `addToWindow()` to register its
  // listener; the test then calls that listener directly with a bubbled event
  // and with the popup's own event. `getElementById` records the lookups, so an
  // early return is observable without needing a real popup.
  const lookups: string[] = [];
  const listeners = new Map<string, (event: Event) => void>();

  const popupStub = {
    id: "zotero-itemmenu",
    addEventListener: (type: string, fn: (event: Event) => void) => listeners.set(type, fn),
    removeEventListener: () => {},
  };
  const windowStub = {
    document: {
      title: "stub",
      getElementById: (id: string) => {
        lookups.push(id);
        return id === "zotero-itemmenu" ? popupStub : null;
      },
    },
  } as unknown as Window;

  const manager = new MenuManager("llmsummarizer");
  manager.addToWindow(windowStub);

  const handler = listeners.get("popupshowing");
  check("item menu registers a popupshowing listener", Boolean(handler));

  if (handler) {
    const bubbled = {
      target: { id: "llmsummarizer-menu-root-popup" },
      currentTarget: popupStub,
    } as unknown as Event;

    lookups.length = 0;
    handler(bubbled);
    check(
      "popupshowing bubbled from the submenu does not rebuild the menu",
      !lookups.includes("llmsummarizer-menu-root"),
      `menu was rebuilt; getElementById calls: ${lookups.join(", ") || "(none)"}`,
    );

    const own = { target: popupStub, currentTarget: popupStub } as unknown as Event;

    lookups.length = 0;
    handler(own);
    check(
      "the popup's own popupshowing does rebuild the menu",
      lookups.includes("llmsummarizer-menu-root"),
      `getElementById calls: ${lookups.join(", ") || "(none)"}`,
    );
  }

  manager.removeFromWindow(windowStub);
}

// ------------------------------------------------------------- note placement

{
  // Regression: summarising a PDF that has no bibliographic parent — a file
  // dropped straight into the library — failed *after* the model had answered,
  // with "Parent item 1/… must be a regular item" from Zotero's own
  // `Item._saveData`. The resolver asked `item.topLevelItem ?? item`, but
  // `topLevelItem` walks the parent chain and returns the item *itself* when
  // there is none: it never yields null, so the `??` could not fire and the
  // attachment itself was handed to Zotero as the note's parent.
  //
  // The stubs below reproduce exactly that shape — `topLevelItem` pointing at
  // the item itself — which is what Zotero returns for a top-level item.
  const regular: Record<string, unknown> = {
    id: 7,
    libraryKey: "1/AAAA1111",
    isRegularItem: () => true,
  };
  regular.topLevelItem = regular;

  const attachedPDF: Record<string, unknown> = {
    id: 8,
    libraryKey: "1/BBBB2222",
    isRegularItem: () => false,
    topLevelItem: regular,
  };

  const standalonePDF: Record<string, unknown> = {
    id: 9,
    libraryKey: "1/CCCC3333",
    isRegularItem: () => false,
  };
  standalonePDF.topLevelItem = standalonePDF;

  const regularItem = regular as unknown as ZoteroItem;

  const regularTarget = resolveNoteTarget(regularItem);
  checkEqual("a regular item is its own note parent", regularTarget.kind, "child");
  check(
    "a regular item is not re-resolved to something else",
    regularTarget.kind === "child" && regularTarget.parent === regularItem,
  );

  const childTarget = resolveNoteTarget(attachedPDF as unknown as ZoteroItem);
  checkEqual("a PDF with a parent attaches to the parent", childTarget.kind, "child");
  check(
    "the walk lands on the bibliographic item, not the attachment",
    childTarget.kind === "child" && childTarget.parent === regularItem,
  );

  // The self-reference is the whole point: it is why `?? item` was dead code.
  check(
    "a top-level item's topLevelItem is itself (the old fallback was unreachable)",
    standalonePDF.topLevelItem === standalonePDF,
  );

  const standaloneTarget = resolveNoteTarget(standalonePDF as unknown as ZoteroItem);
  checkEqual(
    "a PDF with no parent is not offered as a note parent",
    standaloneTarget.kind,
    "standalone",
  );
  check(
    "a standalone PDF is never its own note parent",
    !(standaloneTarget.kind === "child" && standaloneTarget.parent === (standalonePDF as unknown as ZoteroItem)),
  );
}

// --------------------------------------------------------------------- report

check("no unexpected Zotero.logError calls", errors.length === 0, String(errors[0] ?? ""));

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const failure of failures) {
    console.log(`  ✗ ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("all good\n");
}
