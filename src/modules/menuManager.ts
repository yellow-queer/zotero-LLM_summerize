import { log, logError } from "../utils/env";
import { getPromptTemplates, getStringPref } from "../utils/prefs";
import { LLMError, chatCompletion } from "./llmClient";
import { NoteError, createSummaryNote } from "./noteManager";
import { buildPromptContext, renderPrompt, resolveTemplate } from "./promptLibrary";
import { ExtractionError, prepareTextForLLM, resolveAttachment } from "./textExtractor";

/**
 * Zotero 7 context-menu integration for the item tree.
 *
 * Zotero 7 dropped XUL overlays, so the menu is injected by appending a
 * `<menu>` directly into the existing `#zotero-itemmenu` popup and removing it
 * again in `removeFromWindow()`. Everything is built with `createXULElement()`,
 * the Gecko `Document` method for constructing XUL nodes from a script (the
 * `createElement()` used for HTML cannot make XUL elements).
 *
 * `Zotero.MenuManager` would be the supported way to do this, but it only
 * arrived in Zotero 8: `pluginAPI/menuManager.js` is absent from the 7.x trees
 * entirely, and the manifest declares `strict_min_version: 7.0`. Hand-injecting
 * into `#zotero-itemmenu` is what keeps 7.x working.
 *
 * The menu is built lazily on `popupshowing` because the selection is only
 * meaningful then; Zotero fires this event before the popup is displayed.
 *
 * The listener *must* check that the event originated on the popup itself.
 * `popupshowing` bubbles, and our own `menupopup` is a descendant of
 * `#zotero-itemmenu` — so hovering the submenu fires the event again on the
 * child, it bubbles up to the parent, and the handler then deletes the very
 * element the user is hovering. The visible result is a submenu that flickers
 * between highlighted and unhighlighted and never opens. Zotero's own
 * `xpcom/pluginAPI/menuManager.js` guards every `popupshowing` and `command`
 * listener with the same `target !== currentTarget` test.
 */

const MENU_ROOT_ID = "llmsummarizer-menu-root";
const MAX_CONCURRENT_SUMMARIES = 3;

/** Guards against a user re-triggering the same item while work is in flight. */
const inFlight = new Set<number>();

interface MenuWindowState {
  /** The `popupshowing` listener, kept so it can be detached again. */
  handler: (event: Event) => void;
}

export class MenuManager {
  private readonly addonRef: string;
  private readonly windows = new Map<Window, MenuWindowState>();

  constructor(addonRef: string) {
    this.addonRef = addonRef;
  }

  /** Injects the menu into a main window. Idempotent. */
  addToWindow(window: Window): void {
    if (this.windows.has(window)) {
      return;
    }

    const popup = window.document.getElementById("zotero-itemmenu");
    if (!popup) {
      // Not the main Zotero window (e.g. the Reader or a preferences window).
      return;
    }

    const handler = (event: Event) => this.onPopupShowing(event, window);
    popup.addEventListener("popupshowing", handler);
    this.windows.set(window, { handler });
    log(`Item menu registered in "${window.document.title || "window"}"`);
  }

  removeFromWindow(window: Window): void {
    const state = this.windows.get(window);
    if (!state) {
      return;
    }
    window.document
      .getElementById("zotero-itemmenu")
      ?.removeEventListener("popupshowing", state.handler);
    window.document.getElementById(MENU_ROOT_ID)?.remove();
    this.windows.delete(window);
  }

  removeAll(): void {
    for (const window of Array.from(this.windows.keys())) {
      this.removeFromWindow(window);
    }
  }

  // ------------------------------------------------------------------ building

  /**
   * `popupshowing` listener for `#zotero-itemmenu`.
   *
   * Only acts on the event the popup raised for itself. A `popupshowing` that
   * bubbled up from our own submenu means the user is opening the submenu, not
   * the item menu, and rebuilding at that moment would destroy the element under
   * the cursor. See the class doc comment.
   */
  private onPopupShowing(event: Event, window: Window): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    this.rebuildMenu(window);
  }

  /**
   * Rebuilds the submenu for the current selection.
   *
   * The template list is read on every open rather than cached, because
   * templates can be edited in the preferences window while the item tree stays
   * open — a cached menu would keep offering deleted templates.
   */
  private rebuildMenu(window: Window): void {
    const doc = window.document;
    doc.getElementById(MENU_ROOT_ID)?.remove();

    const items = this.getSelectedItems(window);
    if (!items.length) {
      return;
    }

    const popup = doc.getElementById("zotero-itemmenu");
    if (!popup) {
      return;
    }

    // Plain text, no emoji and no icon class: Zotero's item context menu is
    // deliberately icon-free — its stylesheet forces
    // `list-style-image: none !important` on `.menu-iconic` / `.menuitem-iconic`
    // within `#zotero-itemmenu`, so an icon class is a no-op here. Emoji were
    // dropped too: Zotero sets `:root { font-family: system-ui, … }` with no
    // emoji font in the stack, so 🤖 rendered inconsistently.
    const root = this.createXULElement(doc, "menu", {
      id: MENU_ROOT_ID,
      label: "AI 文献总结",
    });

    const submenu = this.createXULElement(doc, "menupopup", {
      id: `${MENU_ROOT_ID}-popup`,
    });
    root.appendChild(submenu);

    const templates = getPromptTemplates();
    for (const template of templates) {
      const menuitem = this.createXULElement(doc, "menuitem", {
        label: template.name,
        // `data-*` keeps a non-ASCII-safe id out of the DOM lookup path.
        "data-template-id": template.id,
      });
      menuitem.addEventListener("command", () => {
        void this.runSummary(items, template.id, window);
      });
      submenu.appendChild(menuitem);
    }

    if (templates.length) {
      submenu.appendChild(this.createXULElement(doc, "menuseparator", {}));
    }

    const settingsItem = this.createXULElement(doc, "menuitem", {
      label: "配置 API 与 Prompt 模板…",
    });
    settingsItem.addEventListener("command", () => {
      openPreferencesPane(`zotero-prefpane-${this.addonRef}`);
    });
    submenu.appendChild(settingsItem);

    // Disabling the whole submenu (rather than hiding it) tells the user why
    // nothing happens, which matters when the selection is a plain webpage
    // snapshot or a note.
    const usable = items.some((item) => this.canSummarize(item));
    root.setAttribute("disabled", usable ? "false" : "true");
    if (!usable) {
      root.setAttribute("tooltiptext", "选中的条目中没有可解析的 PDF 附件");
    }

    popup.appendChild(root);
  }

  private createXULElement(
    doc: Document,
    tag: string,
    attributes: Record<string, string>,
  ): XULElement {
    const element = doc.createXULElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    return element;
  }

  /**
   * Reads the current selection.
   *
   * `getSelectedItems()` includes both regular items and their child
   * attachments depending on the tree mode, so no extra filtering happens here —
   * `canSummarize()` decides what is actionable.
   */
  private getSelectedItems(window: Window): ZoteroItem[] {
    try {
      // `ZoteroPane` is a per-window singleton attached to the main window.
      const pane = (window as any).ZoteroPane;
      const items = pane?.getSelectedItems?.() ?? [];
      return items.filter((item: unknown): item is ZoteroItem => Boolean(item));
    } catch (e) {
      logError(e);
      return [];
    }
  }

  /** True when the item is (or owns) a PDF attachment we can read text from. */
  private canSummarize(item: ZoteroItem): boolean {
    try {
      return resolveAttachment(item).isPDFAttachment();
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ running

  /**
   * Extracts, calls the model and writes the note for a batch of selected items.
   *
   * Each item is processed independently so one failure (a scanned PDF, a
   * revoked key) does not abort the rest of a multi-item selection.
   */
  private async runSummary(
    items: ZoteroItem[],
    templateId: string,
    window: Window,
  ): Promise<void> {
    const targets = items.filter((item) => this.canSummarize(item) && !inFlight.has(item.id));
    if (!targets.length) {
      this.showError(window, "选中的条目中没有可处理的 PDF 附件（或已有任务正在进行）。");
      return;
    }

    if (!getStringPref("apiKey") && !isLocalEndpoint()) {
      this.showError(
        window,
        "尚未配置 API Key。请先打开「编辑 → 设置 → LLM Summarizer」填写接口信息。",
      );
      return;
    }

    const template = resolveTemplate(templateId);
    const batch = targets.slice(0, MAX_CONCURRENT_SUMMARIES);
    if (targets.length > batch.length) {
      log(`Queue limited to ${batch.length} of ${targets.length} items`);
    }

    await Promise.all(batch.map((item) => this.summarizeOne(item, template, window)));
  }

  private async summarizeOne(
    item: ZoteroItem,
    template: { id: string; name: string; prompt: string },
    window: Window,
  ): Promise<void> {
    inFlight.add(item.id);

    const { line, popup } = this.createProgress(window, item);
    line.setText("正在提取文本…");

    try {
      const { text, truncated } = await prepareTextForLLM(item);
      line.setText("正在呼叫大模型…");

      const context = buildPromptContext(item, text, truncated);
      const prompt = renderPrompt(template, context);
      log(`Prompt built for ${item.libraryKey}: ${prompt.length} chars`);

      const markdown = await chatCompletion([
        {
          role: "system",
          content:
            "你是一位科研文献分析助手。始终输出 GitHub 风格的 Markdown，不要输出 HTML，不要使用代码块包裹整篇回答。",
        },
        { role: "user", content: prompt },
      ]);

      line.setText("正在写入笔记…");
      const summary = await createSummaryNote(item, markdown, template.name);

      line.setItemTypeAndIcon(this.iconFor(item));
      line.setProgress(100);
      // A standalone note is not under the PDF the user clicked, so say so
      // rather than letting them hunt for it in the item tree.
      line.setText(
        summary.standalone ? "已生成独立笔记（该 PDF 没有所属条目）" : `已生成笔记：${template.name}`,
      );

      // Select the new note so the result is visible without hunting for it.
      try {
        const note = Zotero.Items.get(summary.id);
        if (note && !Array.isArray(note)) {
          (window as any).ZoteroPane?.selectItem?.(summary.id);
        }
      } catch (e) {
        log("Could not select the new note", e);
      }

      popup.startCloseTimer(5000);
    } catch (e) {
      logError(e);
      line.setError();
      line.setText(this.describeError(e));
      // Errors need to stay readable far longer than a success confirmation.
      popup.startCloseTimer(12_000);
    } finally {
      inFlight.delete(item.id);
    }
  }

  /** Maps each failure class onto a message the user can act on. */
  private describeError(e: unknown): string {
    if (e instanceof ExtractionError || e instanceof LLMError || e instanceof NoteError) {
      return e.message;
    }
    if (e instanceof Error) {
      return `未预期的错误：${e.message}`;
    }
    return `未预期的错误：${String(e)}`;
  }

  /**
   * Icon key for the progress line.
   *
   * This must be Zotero's own item-type key, not the hyphenated SVG filename:
   * `setItemTypeAndIcon` builds `icon-item-type` plus `data-item-type="<key>"`,
   * and the stylesheet selects on the camel-cased name (`attachmentPDF`), which
   * is exactly what `getItemTypeIconName()` returns.
   */
  private iconFor(item: ZoteroItem): string {
    try {
      return resolveAttachment(item).getItemTypeIconName();
    } catch {
      return "attachment";
    }
  }

  /**
   * Creates the standard Zotero progress popup — the same widget the built-in
   * "Retrieve Metadata" flow uses, so no custom UI is needed.
   */
  private createProgress(
    window: Window,
    item: ZoteroItem,
  ): { line: ZoteroItemProgress; popup: ZoteroProgressWindow } {
    const popup = new Zotero.ProgressWindow({ window });
    popup.changeHeadline("AI 文献总结");
    popup.addDescription(this.describeItem(item) || "正在提取文本并呼叫大模型，请稍候…");
    const line = new popup.ItemProgress(this.iconFor(item), "正在准备…");
    line.setProgress(0);
    popup.show();
    return { line, popup };
  }

  private describeItem(item: ZoteroItem): string {
    try {
      const parent = item.parentItem;
      return parent ? parent.getDisplayTitle() : item.getDisplayTitle();
    } catch {
      return "";
    }
  }

  private showError(window: Window, message: string): void {
    const progress = new Zotero.ProgressWindow({ window });
    progress.changeHeadline("AI 文献总结");
    progress.addDescription(message);
    progress.show();
    progress.startCloseTimer(8000);
  }
}

/**
 * Opens Zotero's preferences window focused on this plugin's pane.
 *
 * `Zotero.Utilities.Internal.openPreferences()` is the supported entry point.
 * The `openDialog` fallback relies on a documented contract of the preferences
 * window: it reads the pane to display from `window.arguments[0].pane`
 * (see `Zotero_Preferences.init()` in Zotero's `preferences.js`).
 */
function openPreferencesPane(paneID: string): void {
  const internal = (Zotero as unknown as { Utilities?: { Internal?: Record<string, unknown> } })
    .Utilities?.Internal;
  if (typeof internal?.openPreferences === "function") {
    (internal.openPreferences as (id: string) => void)(paneID);
    return;
  }
  try {
    const mainWindow = Zotero.getMainWindow();
    if (!mainWindow) {
      // Reached from a menu click, so there is normally a window; if there is
      // not, say so rather than letting a TypeError be swallowed into silence.
      throw new Error("没有可用的 Zotero 主窗口，无法打开设置面板。");
    }
    mainWindow.openDialog(
      "chrome://zotero/content/preferences/preferences.xhtml",
      "zotero-prefs",
      "chrome,titlebar,toolbar,centerscreen,resizable=yes",
      { pane: paneID },
    );
  } catch (e) {
    logError(e);
  }
}

/**
 * Local runtimes (Ollama, LM Studio, vLLM) accept requests without a key, so a
 * missing key must not block those users.
 */
function isLocalEndpoint(): boolean {
  const baseUrl = getStringPref("apiBaseUrl").toLowerCase();
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(baseUrl);
}
