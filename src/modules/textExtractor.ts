import { log } from "../utils/env";
import { getNumberPref } from "../utils/prefs";

/**
 * How a document is sliced when it exceeds the safe character budget.
 * The numbers are intentionally explicit rather than a single "keep ratio" so
 * the two console-visible branches read the same on every caller.
 */
const HEAD_RATIO = 0.6;
const TAIL_RATIO = 0.4;

/** Thrown for input problems the user can act on (wrong item type, no text). */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

/** `Zotero.Items.get()` yields `false` for IDs that no longer resolve. */
function isItem(value: unknown): value is ZoteroItem {
  return Boolean(value) && typeof value === "object" && typeof (value as ZoteroItem).id === "number";
}

/**
 * The item that actually owns the PDF file.
 *
 * Zotero's data model is `top-level item → attachment`. A note attached to the
 * PDF is legal but wrong here: notes created "into" a PDF don't show up under
 * the parent bibliography entry the way users expect.
 */
export function resolveAttachment(item: ZoteroItem): ZoteroItem {
  if (item.isAttachment()) {
    return item;
  }
  if (item.isRegularItem()) {
    const pdf = item
      .getAttachments()
      .map((id) => Zotero.Items.get(id))
      .find((att): att is ZoteroItem => isItem(att) && att.isPDFAttachment());
    if (pdf) {
      return pdf;
    }
    throw new ExtractionError(
      "所选条目下没有找到 PDF 附件。请先为该条目添加 PDF 全文，或直接右键点击 PDF 附件。",
    );
  }
  throw new ExtractionError(
    "不支持的条目类型。请选中一个 PDF 附件，或带有 PDF 附件的文献条目。",
  );
}

/**
 * Extracts the plain text of a PDF attachment.
 *
 * `Zotero.Item.prototype.attachmentText` is the lightest reliable path: it
 * returns the `.zotero-ft-cache` content when the item is already indexed, and
 * otherwise falls back to `Zotero.PDFWorker.getFullText()` via pdf.js. Using it
 * means the plugin ships zero PDF-parsing code.
 *
 * @see https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/data/item.js
 *      (`attachmentText` — the cache-file / PDFWorker branch)
 */
export async function extractTextFromAttachment(item: ZoteroItem): Promise<string> {
  const attachment = resolveAttachment(item);

  if (!attachment.isPDFAttachment()) {
    throw new ExtractionError(
      "当前仅支持 PDF 附件。Word/EPUB 等格式将在后续版本通过独立的解析器接口支持。",
    );
  }

  const filePath = await attachment.getFilePathAsync();
  if (!filePath) {
    throw new ExtractionError(
      "该附件没有可读取的本地文件（可能是链接附件且文件已移动，或尚未下载）。",
    );
  }

  let raw: string;
  try {
    raw = await attachment.attachmentText;
  } catch (e) {
    log("attachmentText failed, retrying after a full-text index", e);
    // A corrupt or stale cache is the usual cause; re-indexing rewrites it.
    await (Zotero.Fulltext as any).indexItems([attachment.id], { ignoreErrors: true });
    raw = await attachment.attachmentText;
  }

  const text = cleanText(raw);
  if (!text) {
    throw new ExtractionError(
      "未能从该 PDF 中提取到文本。它可能是扫描件或受密码保护，需要 OCR 后才能总结。",
    );
  }

  log(`Extracted ${text.length} chars from attachment ${attachment.libraryKey}`);
  return text;
}

/**
 * Collapses the layout artefacts pdf.js leaves behind while keeping the text
 * itself byte-identical — an LLM reading a garbled citation loses accuracy.
 */
export function cleanText(raw: string | undefined | null): string {
  if (!raw) {
    return "";
  }
  return raw
    // Hard hyphenation at line ends ("infor-\nmation" → "information").
    .replace(/([A-Za-z])-\s*\n\s*([a-z])/g, "$1$2")
    // Hard-wrapped sentences: join lines that clearly continue a paragraph.
    .replace(/([^\n.!?:;”")\]])\n(?=[a-z(])/g, "$1 ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Enforces the character budget.
 *
 * A middle truncation is deliberate: in academic PDFs the abstract,
 * introduction and conclusion sit at the ends, while the middle is dominated by
 * related work and proofs. Page 1 also carries the title and authors.
 */
export function truncateSmart(
  text: string,
  maxChars = getNumberPref("maxChars", 1000, 500_000),
): { text: string; truncated: boolean; omittedChars: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, omittedChars: 0 };
  }

  const marker =
    "\n\n[... 为控制上下文长度，此处省略了论文中间部分的内容 ...]\n\n";
  const budget = Math.max(0, maxChars - marker.length);
  const headLength = Math.floor(budget * HEAD_RATIO);
  const tailLength = Math.floor(budget * TAIL_RATIO);

  const omittedChars = text.length - headLength - tailLength;
  log(`Truncating ${text.length} chars → ${maxChars} (omitted ${omittedChars})`);

  return {
    text: text.slice(0, headLength) + marker + text.slice(text.length - tailLength),
    truncated: true,
    omittedChars,
  };
}

/**
 * Convenience wrapper used by the menu handler: resolve, extract and truncate
 * in one call.
 */
export async function prepareTextForLLM(item: ZoteroItem): Promise<{
  text: string;
  attachment: ZoteroItem;
  truncated: boolean;
}> {
  const attachment = resolveAttachment(item);
  const full = await extractTextFromAttachment(attachment);
  const { text, truncated } = truncateSmart(full);
  return { text, attachment, truncated };
}
