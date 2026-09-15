import { PromptTemplate, getPromptTemplates, getTemplateById, getStringPref } from "../utils/prefs";
import { log } from "../utils/env";

/**
 * Placeholder substitution for the Prompt library.
 *
 * The contract is deliberately forgiving: an unknown placeholder is left
 * untouched rather than blanked, so a user who typos `{{creaters}}` sees the
 * mistake in the rendered prompt instead of silently sending an empty string.
 * `{{content}}` is the only required slot.
 */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

export interface PromptContext {
  content: string;
  title: string;
  creators: string;
  year: string;
  publication: string;
  date: string;
  itemType: string;
  /** Appended to the prompt so the model knows the text was cut. */
  truncated?: boolean;
}

/**
 * Collects the bibliographic variables available to templates.
 *
 * `Zotero.Item.prototype.getField()` is synchronous once the item's data is
 * loaded, which it always is for items selected in the item tree.
 */
export function buildPromptContext(
  item: ZoteroItem,
  content: string,
  truncated = false,
): PromptContext {
  const meta = resolveMetadataItem(item);
  const creators = safeCall(() =>
    meta
      .getCreators()
      .map((c) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(" "))
      .filter(Boolean)
      .join(", "),
  );

  return {
    content,
    title: safeCall(() => meta.getField("title")) || meta.getDisplayTitle() || "未命名文献",
    creators: creators || "未知",
    year: safeCall(() => meta.getField("year") || meta.getField("date")) || "未知",
    publication:
      safeCall(
        () =>
          meta.getField("publicationTitle") ||
          meta.getField("proceedingsTitle") ||
          meta.getField("publisher"),
      ) || "未知",
    date: safeCall(() => meta.getField("date")) || "未知",
    itemType: safeCall(() => meta.itemType) || "",
    truncated,
  };
}

/**
 * Templates should be filled with the *bibliographic* item's fields, not the
 * attachment's — a PDF attachment has no `publicationTitle`.
 */
function resolveMetadataItem(item: ZoteroItem): ZoteroItem {
  if (item.isAttachment() && item.parentItemID) {
    const parent = Zotero.Items.get(item.parentItemID as number);
    if (parent && !Array.isArray(parent)) {
      return parent;
    }
  }
  return item;
}

function safeCall<T>(fn: () => T): string {
  try {
    const value = fn();
    return typeof value === "string" ? value.trim() : String(value ?? "").trim();
  } catch (e) {
    log("Field lookup failed", e);
    return "";
  }
}

const TRUNCATION_NOTICE =
  "\n\n[注意] 由于原文过长，以上内容为论文的开头与结尾部分，中间章节已被省略，请在总结中说明这一限制。";

/**
 * Expands a template into the final prompt string.
 *
 * `{{content}}` is substituted last so that document text containing literal
 * `{{...}}` sequences cannot inject values into the other placeholders.
 */
export function renderPrompt(template: PromptTemplate, context: PromptContext): string {
  const values: Record<string, string> = {
    title: context.title,
    creators: context.creators,
    year: context.year,
    publication: context.publication,
    date: context.date,
    itemType: context.itemType,
  };

  let prompt = template.prompt.replace(PLACEHOLDER, (raw, name: string) => {
    if (name === "content") {
      return raw;
    }
    return values[name] ?? raw;
  });

  const content = context.truncated ? context.content + TRUNCATION_NOTICE : context.content;
  prompt = prompt.replace(/\{\{\s*content\s*\}\}/g, () => content);

  if (!/\{\{\s*content\s*\}\}/.test(template.prompt)) {
    // A template without the slot would otherwise never see the paper at all.
    prompt += `\n\n论文全文：\n${content}`;
  }

  return prompt + getLanguageDirective();
}

/**
 * Locates a template by ID, falling back to the built-in library and finally
 * to the first available template so a stale ID in a menu item cannot break the
 * action.
 */
export function resolveTemplate(templateId: string): PromptTemplate {
  const all = getPromptTemplates();
  return getTemplateById(templateId) ?? all[0];
}

/**
 * Optional output-language nudge. Templates are written in Chinese, so this is
 * only applied when the user has switched the language away from the default.
 */
export function getLanguageDirective(): string {
  const language = getStringPref("language");
  if (!language || language === "zh-CN") {
    return "";
  }
  return `\n\n请使用 ${language} 输出。`;
}
