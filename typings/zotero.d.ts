/**
 * Minimal ambient declarations for the Zotero 7 runtime.
 *
 * Only the surface this plugin actually touches is declared. Everything is kept
 * structurally compatible with the real Zotero 7 / Firefox 102+ ESR (Gecko)
 * API so that the code also compiles against the full `zotero-types` package
 * (`npm i -D zotero-types` and drop this file from `tsconfig.json`'s `include`).
 *
 * Key Zotero 7 notes encoded here:
 *  - `Zotero.Prefs.get/set` — synchronous pref access (raw values, no JSON parsing).
 *  - `Zotero.PreferencePanes.register` — the only supported way to add a settings
 *    pane; the old XUL Overlay `<prefwindow>` mechanism no longer exists.
 *  - `Zotero.Item.prototype.attachmentText` — async getter delivering cached or
 *    on-demand extracted PDF text.
 *  - `Zotero.ProgressWindow` / `ItemProgress` — the standard non-blocking status UI.
 */

declare const Zotero: ZoteroNamespace;
declare const Services: any;
declare const Components: any;
declare const ChromeUtils: any;
declare const IOUtils: any;
declare const PathUtils: any;

/**
 * The plugin sandbox's global `this`. Plugin bootstrap assigns `_globalThis` to
 * the sandbox itself so top-level variables become globally reachable.
 * @see addon/bootstrap.js
 */
declare const _globalThis: any;

interface ZoteroNamespace {
  debug(message: string, level?: number): void;
  logError(error: unknown): void;
  warn(message: string): void;
  /**
   * The most recent `navigator:browser` window, or `null` when none is open —
   * `Services.wm.getMostRecentWindow()` returns null rather than throwing, so
   * callers must handle the empty case (startup, shutdown, macOS with every
   * window closed). Declared nullable deliberately: an over-confident `Window`
   * here compiles fine and then fails at runtime, the same way the `itemType`
   * declaration did.
   */
  getMainWindow(): Window | null;
  /** All open main windows. Empty while Zotero is starting or shutting down. */
  getMainWindows(): Window[];
  getString(name: string, params?: string | string[]): string;
  /** Resolves an item ID (or array of IDs) to `Zotero.Item` instances. */
  Items: {
    get(id: number | number[]): ZoteroItem | ZoteroItem[] | false;
    getAsync(id: number | number[]): Promise<ZoteroItem | ZoteroItem[] | false>;
  };
  /** Item constructor. Takes exactly one argument: an item type name or an ID. */
  Item: ZoteroItemConstructor;
  Utilities: ZoteroUtilities;
  Prefs: ZoteroPrefs;
  PreferencePanes: ZoteroPreferencePanes;
  ProgressWindow: ZoteroProgressWindowConstructor;
  Fulltext: any;
  PDFWorker: any;
  File: any;
  MIME: any;
  Notes: any;
}

interface ZoteroPrefs {
  /** Read a pref. `global` must be `true` for values outside the current scope. */
  get(pref: string, global?: boolean): any;
  set(pref: string, value: any, global?: boolean): void;
  clear(pref: string, global?: boolean): void;
  registerObserver(pref: string, handler: () => void, global?: boolean): symbol;
}

interface ZoteroPreferencePaneOptions {
  /** ID of the plugin registering the pane — it is auto-unregistered on shutdown. */
  pluginID: string;
  /** URI (or plugin-root-relative path) of an XHTML *fragment*, not a full document. */
  src: string;
  id?: string;
  parent?: string;
  label?: string;
  image?: string;
  scripts?: string[];
  stylesheets?: string[];
  helpURL?: string;
}

interface ZoteroPreferencePanes {
  register(options: ZoteroPreferencePaneOptions): Promise<string>;
  unregister(id: string): void;
}

interface ZoteroItemConstructor {
  /** @param itemTypeOrID item type name (`"note"`, `"attachment"`) or a numeric item ID. */
  new (itemTypeOrID: string | number): ZoteroItem;
}

interface ZoteroItem {
  readonly id: number;
  /** Writable on unsaved items — set it before the first `saveTx()`. */
  libraryID: number;
  readonly key: string;
  readonly libraryKey: string;
  parentItemID: number | false;
  /** Present on attachment items: MIME type of the attached file. */
  attachmentContentType: string | false;
  /** Present on note items: the note body as an HTML string. */
  readonly note: string;
  /** Async getter: extracted text for a supported attachment (PDF/TXT/HTML). */
  readonly attachmentText: Promise<string>;
  /** Cached parent item, or `undefined` for top-level items. */
  readonly parentItem: ZoteroItem | undefined;
  /** Walks up `parentItem` links to the topmost item. */
  readonly topLevelItem: ZoteroItem;
  /** Note title. Throws when called on anything that is not a note or attachment. */
  getNoteTitle(): string;

  isAttachment(): boolean;
  isFileAttachment(): boolean;
  isPDFAttachment(): boolean;
  isNote(): boolean;
  isRegularItem(): boolean;
  isTopLevelItem(): boolean;
  isAnnotation(): boolean;

  /** IDs of this item's child attachments (PDFs, snapshots, linked files). */
  getAttachments(): number[];
  /**
   * IDs of the collections this item is filed in. Throws if a recorded
   * collection no longer exists, so treat it as fallible when it is only being
   * used to place a new item somewhere tidy.
   */
  getCollections(includeTrashed?: boolean): number[];
  /** Marks the collection list dirty; a separate `saveTx()` persists it. */
  setCollections(collectionIDsOrKeys: Array<number | string>): void;
  /**
   * Adds a `dc:relation` link. Both items must already be in the same library,
   * and the link is persisted by the next save.
   */
  addRelatedItem(item: ZoteroItem): boolean;
  getField(field: string, unformatted?: boolean, includeBaseMapped?: boolean): string;
  setField(field: string, value: string): void;
  /**
   * Item type name, e.g. `journalArticle` or `attachment`.
   *
   * A *getter*, not a method — `Zotero.defineProperty(Zotero.Item.prototype,
   * 'itemType', …)`. There is no `getItemType()`; declaring one here compiles
   * fine and then throws `TypeError: getItemType is not a function` at runtime,
   * which is exactly how that mistake escaped type checking once already.
   */
  readonly itemType: string;
  /** CSS icon key for the item type, e.g. `attachmentPDF` (camel-cased, no hyphen). */
  getItemTypeIconName(): string;
  getCreators(): Array<{ firstName?: string; lastName?: string; name?: string; creatorType?: string }>;
  getDisplayTitle(): string;
  getFilePathAsync(): Promise<string | false>;
  setNote(text: string): void;
  getNote(): string;
  getNotes(): number[];
  addTag(tag: string, type?: number): boolean;
  /**
   * Rejects on failure. `errorHandler` only observes the error — it decides
   * whether Zotero *also* reports it through `Zotero.logError`, and does not
   * stop the rejection (`Zotero.DataObject#save()` rethrows unconditionally).
   * A `catch` is therefore the only way to report a failed save.
   */
  saveTx(options?: {
    skipSelect?: boolean;
    errorHandler?: (error: unknown) => void;
  }): Promise<number | boolean | undefined>;
  save(options?: {
    skipSelect?: boolean;
    errorHandler?: (error: unknown) => void;
  }): Promise<number | boolean | undefined>;
}

interface ZoteroItemProgress {
  setText(text: string): void;
  setProgress(percent: number): void;
  setItemTypeAndIcon(itemType?: string, cssIcon?: string): void;
  /** Paints the line red with a cross icon — used for failure states. */
  setError(): void;
}

interface ZoteroProgressWindowConstructor {
  new (options?: { window?: Window; closeOnClick?: boolean }): ZoteroProgressWindow;
}

interface ZoteroProgressWindow {
  show(): boolean | void;
  changeHeadline(text: string, cssIconKey?: string, postText?: string): void;
  addDescription(text: string): void;
  addLines(labels: string | string[], icons: string | string[]): void;
  /** `ms = 2500` default; pass a larger value to keep the message on screen. */
  startCloseTimer(ms?: number, requireMouseOver?: boolean): void;
  close(): void;
  ItemProgress: {
    new (itemType: string | false | undefined, text: string): ZoteroItemProgress;
  };
}
