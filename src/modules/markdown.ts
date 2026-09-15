/**
 * Markdown → Zotero note HTML.
 *
 * Zotero notes are HTML stored in `itemNotes.note` and rendered by a ProseMirror
 * schema that accepts the same tag set a browser does, so no third-party
 * markdown library is required (keeping the bundled `.xpi` small). This module
 * therefore implements the subset an LLM actually emits — headings, emphasis,
 * code, links, nested lists, tables, blockquotes, rules — and escapes
 * everything else.
 *
 * Ordering matters: block parsing runs first on raw lines, then inline parsing
 * runs on each block's text. Escaping happens only on literal text segments, so
 * generated tags are never escaped and never double-escaped.
 */

/** Schemes allowed in generated links; blocks `javascript:` and `data:`. */
const SAFE_LINK_SCHEME = /^(https?:|mailto:|#|\/)/i;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The first block-level `<h1>` of a rendered document, if it starts with one. */
const LEADING_H1 = /^\s*<h1([^>]*)>([\s\S]*?)<\/h1>/i;

/**
 * Converts a Markdown document into HTML accepted by the Zotero note editor.
 *
 * Zotero takes a note's display title from the first heading in its body
 * (`Zotero.Utilities.Item.noteToTitle()`), so when `title` is given it is always
 * emitted first and any `<h1>` the model wrote itself is demoted to `<h2>`.
 * That keeps the item tree showing *which template* produced each note; letting
 * the model's own heading win would make the title depend on the paper.
 */
export function markdownToNoteHTML(markdown: string, title?: string): string {
  const lines = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  let html = renderBlocks(lines);

  if (title) {
    html = html.replace(LEADING_H1, "<h2$1>$2</h2>");
    html = `<h1>${escapeHtml(title)}</h1>\n${html}`;
  }
  return html;
}

/** First ATX heading or non-empty line, used as a fallback note title. */
export function extractTitle(markdown: string): string {
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const heading = HEADING.exec(trimmed);
    return (heading ? heading[2] : trimmed).replace(/[*_`]/g, "").slice(0, 120);
  }
  return "";
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker, language] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (or fall off the end)
      const langAttr = language ? ` class="language-${escapeHtml(language)}"` : "";
      out.push(`<pre><code${langAttr}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])![1]);
        i++;
      }
      out.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const { html, next } = renderTable(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const { html, next } = renderList(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsNewBlock(lines, i)) {
      paragraph.push(lines[i].trim());
      i++;
    }
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    }
  }

  return out.join("\n");
}

/** True when `lines[i]` begins a construct that must interrupt a paragraph. */
function startsNewBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE.test(line) ||
    RULE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    isTableStart(lines, i)
  );
}

interface ListItem {
  content: string;
  /** Nested list owned by this item, or `null` when it has none. */
  children: ListBlock | null;
}

/** A single list level. Each level carries its own `ordered` flag, so a bullet
 *  list nested under a numbered item stays a bullet list. */
interface ListBlock {
  ordered: boolean;
  items: ListItem[];
}

/**
 * Renders a nested list. Nesting is derived from indentation width, which is
 * how every LLM formats sub-points (two or four spaces, or a tab).
 */
function renderList(lines: string[], start: number): { html: string; next: number } {
  const root: ListBlock = { ordered: false, items: [] };
  // Stack of currently-open levels, innermost last. The root level is pushed on
  // the first line, once its indent is known — seeding it with a sentinel
  // indent would make the first real item look like a nested list.
  const stack: Array<{ indent: number; block: ListBlock }> = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const match = BULLET.exec(line) ?? ORDERED.exec(line);
    if (!match) {
      break;
    }

    const indent = expandIndent(match[1]);
    const ordered = !BULLET.test(line);
    const item: ListItem = { content: match[3], children: null };

    if (!stack.length) {
      root.ordered = ordered;
      stack.push({ indent, block: root });
    } else {
      // Close levels this line has dedented out of, but never drop the root.
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
        stack.pop();
      }

      const top = stack[stack.length - 1];
      if (indent > top.indent) {
        // Deeper than the current level: the new list is owned by the previous
        // item, and its tag comes from *its own* markers, not the parent's.
        const parentItem = top.block.items[top.block.items.length - 1];
        if (parentItem) {
          parentItem.children = { ordered, items: [] };
          stack.push({ indent, block: parentItem.children });
        }
      } else if (indent < top.indent && stack.length === 1) {
        // Dedented past the root indent: continue as the same root list, but
        // adopt the new indent so subsequent siblings align correctly.
        stack[0] = { indent, block: root };
      }
    }

    stack[stack.length - 1].block.items.push(item);
    i++;
  }

  const render = (block: ListBlock): string => {
    const tag = block.ordered ? "ol" : "ul";
    const body = block.items
      .map(
        (item) =>
          `<li>${renderInline(item.content)}${item.children ? render(item.children) : ""}</li>`,
      )
      .join("");
    return `<${tag}>${body}</${tag}>`;
  };

  return { html: render(root), next: i };
}

function expandIndent(whitespace: string): number {
  let width = 0;
  for (const char of whitespace) {
    width += char === "\t" ? 4 : 1;
  }
  return width;
}

function isTableStart(lines: string[], i: number): boolean {
  return (
    i + 1 < lines.length &&
    lines[i].includes("|") &&
    TABLE_DIVIDER.test(lines[i + 1]) &&
    !FENCE.test(lines[i])
  );
}

function renderTable(lines: string[], start: number): { html: string; next: number } {
  const parseRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const header = parseRow(lines[start]);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(parseRow(lines[i]));
    i++;
  }

  const head = `<thead><tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows
        .map(
          (row) =>
            `<tr>${header
              .map((_, index) => `<td>${renderInline(row[index] ?? "")}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody>`
    : "";

  return { html: `<table>${head}${body}</table>`, next: i };
}

/**
 * Inline tokenizer. A single alternation is scanned left-to-right so that the
 * earliest match always wins (`` `a *b*` `` stays literal inside the code span).
 *
 * The pattern is stored as a source string and a fresh `RegExp` is built per
 * call. A module-level regex would be shared by the recursive calls this
 * function makes for nested emphasis, and each recursion would reset
 * `lastIndex` out from under its caller.
 */
const INLINE_SOURCE = [
  "(`+)([\\s\\S]*?)\\1", // 1,2 code span
  "\\*\\*([\\s\\S]+?)\\*\\*", // 3 strong
  "__([\\s\\S]+?)__", // 4 strong
  "~~([\\s\\S]+?)~~", // 5 strikethrough
  "(?<![\\w*])\\*([^*\\n]+?)\\*(?![\\w*])", // 6 em
  "(?<![\\w_])_([^_\\n]+?)_(?![\\w_])", // 7 em
  "!?\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)", // 8,9 link/image
].join("|");

export function renderInline(text: string): string {
  const source = String(text ?? "");
  const pattern = new RegExp(INLINE_SOURCE, "g");
  let out = "";
  let last = 0;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    out += escapeHtml(source.slice(last, match.index));
    last = match.index + match[0].length;

    const [, , code, strongStars, strongUnderscores, strike, emStars, emUnderscores, label, href] =
      match;

    if (code !== undefined) {
      out += `<code>${escapeHtml(code)}</code>`;
    } else if (strongStars !== undefined || strongUnderscores !== undefined) {
      out += `<strong>${renderInline(strongStars ?? strongUnderscores!)}</strong>`;
    } else if (strike !== undefined) {
      out += `<del>${renderInline(strike)}</del>`;
    } else if (emStars !== undefined || emUnderscores !== undefined) {
      out += `<em>${renderInline(emStars ?? emUnderscores!)}</em>`;
    } else if (label !== undefined && href !== undefined) {
      out += SAFE_LINK_SCHEME.test(href)
        ? `<a href="${escapeHtml(href)}">${renderInline(label)}</a>`
        : escapeHtml(label);
    }
  }

  out += escapeHtml(source.slice(last));
  // Preserve the author's line structure; see the module note on soft breaks.
  return out.replace(/\n/g, "<br>");
}
