/**
 * Gecko/Zotero extensions to the standard DOM.
 *
 * Zotero adds `createXULElement()` to every `Document` so scripts can build XUL
 * nodes after the XML-based overlay mechanism was removed in Zotero 7. These
 * declarations merge into `lib.dom`'s interfaces, which is why this file has no
 * top-level imports or exports.
 */

interface XULElement extends Element {}

interface Document {
  /**
   * Creates a XUL element in the XUL namespace, bypassing the default HTML
   * namespace used by `createElement()`.
   */
  createXULElement(tagName: string): XULElement;
}

interface Window {
  /** Per-window Zotero controller for the main window. Absent elsewhere. */
  readonly ZoteroPane?: any;
  /** Cross-realm Event constructor; `lib.dom` does not declare it. */
  readonly Event: typeof Event;
  /** Gecko's `window.openDialog()`, used to open Zotero's chrome dialogs. */
  openDialog(
    url: string,
    name: string,
    features: string,
    args?: unknown,
  ): Window | null;
}

interface ZoteroUtilitiesInternal {
  openPreferences(paneID?: string): void;
}

interface ZoteroUtilities {
  Internal: ZoteroUtilitiesInternal;
  randomString(length?: number): string;
  parseMarkup(text: string): Array<{ type: string; text?: string; href?: string }>;
}
