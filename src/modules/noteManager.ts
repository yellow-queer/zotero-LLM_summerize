import { log } from "../utils/env";
import { markdownToNoteHTML } from "./markdown";

/** Matches `Zotero.Utilities.Item.noteToTitle()`'s own truncation limit. */
const MAX_TITLE_LENGTH = 120;

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

/**
 * Creates a child note holding the rendered summary.
 *
 * Attachment hierarchy rule (this is the part that is easy to get wrong):
 * a note created under a *PDF attachment* is not visible in the item tree the
 * way users expect — Zotero's convention is `bibliographic item → notes`, with
 * the PDF as a sibling. So we always walk up to the top-level item.
 *
 * @param parentItem the item the user right-clicked (attachment or regular item)
 * @param markdownContent the model's raw Markdown response
 * @param templateTitle human-readable template name, used for the note heading
 * @returns the ID of the newly created note
 */
export async function createSummaryNote(
  parentItem: ZoteroItem,
  markdownContent: string,
  templateTitle: string,
): Promise<number> {
  const target = resolveNoteParent(parentItem);
  // The heading has to go into the note *body*: `note` is not a real item type
  // with fields, and `setField("title", …)` on a note throws
  // ("'title' is not a valid field for type 'note'"). Zotero instead derives the
  // title from the first heading when it saves, via
  // `Zotero.Utilities.Item.noteToTitle()`.
  const html = markdownToNoteHTML(markdownContent, buildNoteTitle(templateTitle));

  // `new Zotero.Item('note')` is the Zotero 7 way to build a note; the item must
  // be assigned a library and a parent before `saveTx()` or the save is rejected.
  const note = new Zotero.Item("note");
  note.libraryID = target.libraryID;
  note.parentItemID = target.id;
  note.setNote(html);

  // `saveTx()` resolves with the new item's ID, `true` on update, `false` when
  // nothing changed — and, because `Zotero.DataObject#save()` funnels failures
  // through `_recoverFromSaveError()`, it *resolves with `undefined`* rather
  // than rejecting. Without the `errorHandler` below a failed save would be
  // reported to the user as a success.
  let saveError: unknown = null;
  const result = await note.saveTx({
    errorHandler: (error: unknown) => {
      saveError = error;
    },
  });

  if (saveError) {
    throw new NoteError(`写入笔记失败：${describeSaveError(saveError)}`);
  }
  if (typeof result !== "number") {
    throw new NoteError("写入笔记失败：Zotero 未返回新建笔记的 ID。");
  }

  log(`Created note ${result} under item ${target.libraryKey}`);
  return result;
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
 * Resolves the item a summary should hang off.
 *
 * `topLevelItem` walks the full `parentItem` chain, which also covers the
 * (legal but unusual) `item → attachment → sub-attachment` shape.
 */
export function resolveNoteParent(item: ZoteroItem): ZoteroItem {
  if (item.isAttachment() || item.isNote()) {
    return item.topLevelItem ?? item;
  }
  return item;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Returns an existing note for the same parent item and template, if the user
 * re-runs a summary. Used to warn rather than to silently create duplicates.
 */
export function findExistingSummaryNotes(parentItem: ZoteroItem): ZoteroItem[] {
  const target = resolveNoteParent(parentItem);
  return target
    .getNotes()
    .map((id) => Zotero.Items.get(id))
    .filter((note): note is ZoteroItem => Boolean(note) && !Array.isArray(note));
}
