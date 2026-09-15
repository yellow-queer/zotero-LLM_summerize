import { log } from "../utils/env";
import { markdownToNoteHTML } from "./markdown";

/** Matches `Zotero.Utilities.Item.noteToTitle()`'s own truncation limit. */
const MAX_TITLE_LENGTH = 120;

/** Longest paper title carried into a standalone note's heading. */
const MAX_SUBJECT_LENGTH = 60;

/**
 * Thrown when the note cannot be written. Its message is shown to the user
 * verbatim (see `MenuManager.describeError`), so it is written in plain Chinese
 * rather than as a developer-facing string.
 */
export class NoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteError";
  }
}

/** What `createSummaryNote` produced. */
export interface SummaryNote {
  id: number;
  /**
   * True when the source had no bibliographic item to hang off, so the note was
   * created top-level rather than as a child.
   */
  standalone: boolean;
}

/**
 * Where a summary note can go.
 *
 * `child` — the ordinary case: the note hangs off a regular bibliographic item.
 * `standalone` — the source's topmost ancestor is not a regular item (a PDF
 *   filed straight into the library, with no parent). Zotero refuses a child
 *   note there, so the note is created top-level instead.
 */
export type NoteTarget =
  | { kind: "child"; parent: ZoteroItem }
  | { kind: "standalone" };

/**
 * Creates the note holding the rendered summary.
 *
 * Attachment hierarchy rule (this is the part that is easy to get wrong):
 * a note created under a *PDF attachment* is not visible in the item tree the
 * way users expect — Zotero's convention is `bibliographic item → notes`, with
 * the PDF as a sibling. So we always walk up to the top-level item.
 *
 * That walk cannot always succeed, which is the other half of the rule: Zotero
 * only accepts a note under a *regular* item (`Item._saveData` throws
 * "Parent item … must be a regular item" otherwise), and a standalone PDF has
 * no regular item above it. See `resolveNoteTarget`.
 *
 * @param item the item the user right-clicked (attachment or regular item)
 * @param markdownContent the model's raw Markdown response
 * @param templateTitle human-readable template name, used for the note heading
 * @returns the new note's ID and whether it could be attached to a parent
 */
export async function createSummaryNote(
  item: ZoteroItem,
  markdownContent: string,
  templateTitle: string,
): Promise<SummaryNote> {
  const target = resolveNoteTarget(item);
  // A standalone note has no parent to say what it summarises, so the paper's
  // own name has to go into the heading or the note is unidentifiable in the
  // library.
  const subject = target.kind === "standalone" ? subjectTitle(item) : "";
  const heading = subject ? `${templateTitle} · ${subject}` : templateTitle;
  // The heading has to go into the note *body*: `note` is not a real item type
  // with fields, and `setField("title", …)` on a note throws
  // ("'title' is not a valid field for type 'note'"). Zotero instead derives the
  // title from the first heading when it saves, via
  // `Zotero.Utilities.Item.noteToTitle()`.
  const html = markdownToNoteHTML(markdownContent, buildNoteTitle(heading));

  // `new Zotero.Item('note')` is the Zotero 7 way to build a note; it must be in
  // a library before `saveTx()`. A parent is *not* required — a top-level note
  // is a legal item, which is how Zotero's own `createNoteFromAnnotations()`
  // builds one when it is given a collection instead of a parent
  // (`xpcom/editorInstance.js`).
  const note = new Zotero.Item("note");
  note.libraryID = item.libraryID;
  note.setNote(html);

  if (target.kind === "child") {
    note.parentItemID = target.parent.id;
  } else {
    // File it where the PDF lives and relate the two, because a standalone note
    // has no parent link to do either job.
    try {
      note.setCollections(item.getCollections());
      note.addRelatedItem(item);
    } catch (e) {
      // Best-effort: a summary the user has already paid an API call for must
      // not be lost over where it gets filed.
      log("Could not file the standalone note with its attachment", e);
    }
  }

  // `saveTx()` resolves with the new item's ID, `true` on update, `false` when
  // nothing changed. On failure it *rejects* — `Zotero.DataObject#save()` runs
  // `_recoverFromSaveError()` and then rethrows unconditionally, past any
  // `errorHandler` (which only decides whether Zotero also logs the error), so
  // catching here is the only way the user ever sees why the note is missing.
  // Relying on an `errorHandler` to report the failure cannot work: the `throw`
  // arrives first, which is how "Parent item … must be a regular item" reached
  // the progress window as an unexpected error instead of a note failure.
  let result: number | boolean | undefined;
  try {
    result = await note.saveTx();
  } catch (e) {
    throw new NoteError(`写入笔记失败：${describeSaveError(e)}`);
  }

  if (typeof result !== "number") {
    throw new NoteError("写入笔记失败：Zotero 未返回新建笔记的 ID。");
  }

  log(
    `Created note ${result} under ${
      target.kind === "child"
        ? target.parent.libraryKey
        : `standalone (${item.libraryKey} has no parent item)`
    }`,
  );
  return { id: result, standalone: target.kind === "standalone" };
}

function describeSaveError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Timestamped heading for the note body, e.g. `工科实验精读模版 · 2026-09-15 01:20`.
 *
 * The timestamp is what separates two runs of the same template on the same
 * paper, which would otherwise produce identically-titled sibling notes.
 */
function buildNoteTitle(templateTitle: string): string {
  const date = new Date();
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${templateTitle} · ${stamp}`.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Resolves where a summary should go.
 *
 * `topLevelItem` walks the full `parentItem` chain, which also covers the
 * (legal but unusual) `item → attachment → sub-attachment` shape. The catch is
 * that it returns the item *itself* when there is no parent — it never yields
 * null — so "walk to the top" is not the same as "arrive at a regular item".
 * For a PDF filed straight into the library the walk ends on the attachment,
 * and Zotero rejects a note under an attachment.
 */
export function resolveNoteTarget(item: ZoteroItem): NoteTarget {
  const top = item.topLevelItem;
  return top.isRegularItem() ? { kind: "child", parent: top } : { kind: "standalone" };
}

/**
 * The paper's own title, for a note that has no parent to identify it.
 *
 * Attachments are titled after their filename by default, so a trailing `.pdf`
 * is dropped — the same adjustment Zotero's own "Create Parent Item" makes.
 */
function subjectTitle(item: ZoteroItem): string {
  try {
    return (item.getField("title") || "")
      .replace(/\.pdf$/i, "")
      .slice(0, MAX_SUBJECT_LENGTH);
  } catch {
    // Not every item type has a `title` field.
    return "";
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Returns an existing note for the same parent item and template, if the user
 * re-runs a summary. Used to warn rather than to silently create duplicates.
 */
export function findExistingSummaryNotes(parentItem: ZoteroItem): ZoteroItem[] {
  const target = resolveNoteTarget(parentItem);
  if (target.kind !== "child") {
    // A standalone note hangs off nothing, so there is no parent to enumerate.
    return [];
  }
  return target.parent
    .getNotes()
    .map((id) => Zotero.Items.get(id))
    .filter((note): note is ZoteroItem => Boolean(note) && !Array.isArray(note));
}
