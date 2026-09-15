/**
 * Typed access layer over `Zotero.Prefs`.
 *
 * Every write goes through `defaults`, which mirrors `addon/prefs.js`. That file
 * only runs on first install, so a pref added in a later version would otherwise
 * read back as `undefined` for existing users. Falling back here keeps upgrades
 * seamless without a migration step.
 */

/**
 * Logical preference names. These are the *short* names; `fullPrefKey()` turns
 * them into the fully-qualified keys Zotero actually stores. Keep the set in
 * sync with `addon/prefs.js`.
 */
export const PREF_KEYS = {
  apiBaseUrl: "apiBaseUrl",
  apiKey: "apiKey",
  modelName: "modelName",
  temperature: "temperature",
  maxChars: "maxChars",
  timeoutSeconds: "timeoutSeconds",
  language: "language",
  debug: "debug",
  promptTemplates: "promptTemplates",
} as const;

export type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];

/**
 * `package.json` → `config.prefsPrefix`, injected by `scripts/build.mjs`. The
 * literal is only a fallback for tooling that bundles without that `define`
 * (the self-test does), and must match `config.prefsPrefix`.
 */
const PREFIX: string =
  typeof __prefsPrefix__ === "undefined" ? "extensions.zotero.llmsummarizer" : __prefsPrefix__;

/**
 * Builds the key `Zotero.Prefs` expects.
 *
 * This matters: `Zotero.Prefs.get(name, true)` takes `name` as-is, while the
 * two-argument-free form prepends `extensions.zotero.`. Passing a short name
 * *with* `global = true` therefore reads a completely different pref — the
 * root-level `apiBaseUrl` rather than this plugin's — and fails silently by
 * falling back to the defaults.
 */
export function fullPrefKey(key: PrefKey): string {
  return `${PREFIX}.${key}`;
}

/**
 * Default Prompt library. Seeded into `addon/prefs.js` on install and also used
 * as the runtime fallback, so a corrupted or empty store degrades to these.
 */
export const DEFAULT_PROMPT_TEMPLATES = [
  {
    id: "general-summary",
    name: "通用研读总结",
    builtin: true,
    prompt: [
      "你是一位严谨的科研助理。请阅读以下论文全文，产出一份结构化的中文研读笔记。",
      "",
      "要求：",
      "1. 使用 Markdown 格式输出，包含以下二级标题：研究背景与问题、核心方法、主要结果、结论与局限。",
      "2. 关键结论需标注其在原文中的依据（如章节号或图表编号）。",
      "3. 保留重要的定量数据（指标、数值、单位、对比基线）。",
      "4. 不要杜撰原文中不存在的信息；若某部分缺失，请明确写“原文未提及”。",
      "",
      "论文元信息：标题《{{title}}》，作者：{{creators}}，年份：{{year}}。",
      "",
      "论文全文：",
      "{{content}}",
    ].join("\n"),
  },
  {
    id: "engineering-deep-read",
    name: "工科实验精析",
    builtin: true,
    prompt: [
      "你是一位工程领域的资深审稿人。请对以下论文做深度精读，重点拆解其工程实现与实验设计。",
      "",
      "请按 Markdown 输出，包含以下二级标题：",
      "1. **研究动机与创新点** — 明确列出与已有工作的差异，逐条说明创新程度。",
      "2. **实验设计** — 实验平台/装置、样本规模、对照组设置、变量控制方式。",
      "3. **算法与实现细节** — 关键公式、超参数、复杂度或硬件开销。",
      "4. **关键数据与误差分析** — 提取核心指标表格，指出误差来源与置信区间（若原文给出）。",
      "5. **可复现性评估** — 数据/代码是否公开，复现该实验所需的最小条件。",
      "6. **局限与可改进方向** — 从工程落地角度给出 3 条具体建议。",
      "",
      "论文元信息：标题《{{title}}》，作者：{{creators}}，年份：{{year}}，期刊/会议：{{publication}}。",
      "",
      "论文全文：",
      "{{content}}",
    ].join("\n"),
  },
];

export interface PromptTemplate {
  id: string;
  name: string;
  /** Built-in templates cannot be deleted from the preferences pane. */
  builtin?: boolean;
  prompt: string;
}

const FALLBACKS: Record<PrefKey, unknown> = {
  apiBaseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  modelName: "deepseek-chat",
  // A string, matching the pref's own type in `addon/prefs.js` — Gecko has no
  // float pref, so `getNumberPref` parses this with `Number()`.
  temperature: "0.3",
  maxChars: 25000,
  timeoutSeconds: 60,
  language: "zh-CN",
  debug: false,
  promptTemplates: DEFAULT_PROMPT_TEMPLATES,
};

export function getPref<T>(key: PrefKey, fallback?: T): T {
  const raw = Zotero.Prefs.get(fullPrefKey(key), true);
  if (raw === undefined || raw === null || raw === "") {
    return (fallback !== undefined ? fallback : FALLBACKS[key]) as T;
  }
  return raw as T;
}

export function setPref(key: PrefKey, value: unknown): void {
  Zotero.Prefs.set(fullPrefKey(key), value, true);
}

export function getNumberPref(key: PrefKey, min: number, max: number): number {
  const parsed = Number(getPref(key));
  if (!Number.isFinite(parsed)) {
    return FALLBACKS[key] as number;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function getStringPref(key: PrefKey): string {
  const value = getPref(key);
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

export function getBoolPref(key: PrefKey): boolean {
  return Boolean(getPref(key));
}

/**
 * Reads the Prompt library, repairing the stored JSON when necessary.
 *
 * `Zotero.Prefs.set` stringifies non-string values with `JSON.stringify`
 * (`Zotero.Prefs.get` parses them back), so the stored value round-trips as
 * JSON without any extra encoding on our side.
 */
export function getPromptTemplates(): PromptTemplate[] {
  const raw = Zotero.Prefs.get(fullPrefKey("promptTemplates"), true);
  const parsed = typeof raw === "string" ? safeParse(raw) : raw;

  if (!Array.isArray(parsed) || !parsed.length) {
    return cloneDefaults();
  }

  const templates = parsed.filter(
    (t): t is PromptTemplate =>
      !!t && typeof t === "object" && typeof t.name === "string" && typeof t.prompt === "string",
  );

  return templates.length ? templates : cloneDefaults();
}

export function setPromptTemplates(templates: PromptTemplate[]): void {
  Zotero.Prefs.set(fullPrefKey("promptTemplates"), JSON.stringify(templates), true);
}

export function cloneDefaults(): PromptTemplate[] {
  return JSON.parse(JSON.stringify(DEFAULT_PROMPT_TEMPLATES)) as PromptTemplate[];
}

export function getTemplateById(id: string): PromptTemplate | undefined {
  return getPromptTemplates().find((t) => t.id === id);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    Zotero.logError(e as Error);
    return null;
  }
}
