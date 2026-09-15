/**
 * Default preferences, applied by Zotero on first install only.
 *
 * The full keys are built from `package.json` → `config.prefsPrefix`, so this
 * file must use short names. Anything added here in a later version will NOT be
 * written for existing users — `src/utils/prefs.ts` therefore repeats these
 * values as runtime fallbacks.
 */
pref("apiBaseUrl", "https://api.deepseek.com/v1");
pref("apiKey", "");
pref("modelName", "deepseek-chat");
/**
 * Stored as a *string* on purpose. Gecko prefs have no float type — only
 * bool/int/string — and `Zotero.Plugins.setDefaultPrefs()` routes a JS number
 * through `setIntPref()`, so a literal `0.3` would be silently truncated to `0`
 * and every request would go out with temperature 0.
 *
 * `getNumberPref("temperature", …)` parses it back with `Number()`.
 */
pref("temperature", "0.3");
pref("maxChars", 25000);
pref("timeoutSeconds", 60);
pref("language", "zh-CN");
pref("debug", false);

/**
 * Prompt template library, stored as JSON.
 *
 * `Zotero.Prefs.set()` stringifies non-string values with `JSON.stringify`, so
 * this literal is read back by `Zotero.Prefs.get()` as a parsed array. Template
 * placeholders: {{content}} {{title}} {{creators}} {{year}} {{publication}}.
 */
pref(
  "promptTemplates",
  JSON.stringify([
    {
      id: "general-summary",
      name: "通用研读总结",
      builtin: true,
      prompt:
        "你是一位严谨的科研助理。请阅读以下论文全文，产出一份结构化的中文研读笔记。\n\n要求：\n1. 使用 Markdown 格式输出，包含以下二级标题：研究背景与问题、核心方法、主要结果、结论与局限。\n2. 关键结论需标注其在原文中的依据（如章节号或图表编号）。\n3. 保留重要的定量数据（指标、数值、单位、对比基线）。\n4. 不要杜撰原文中不存在的信息；若某部分缺失，请明确写“原文未提及”。\n\n论文元信息：标题《{{title}}》，作者：{{creators}}，年份：{{year}}。\n\n论文全文：\n{{content}}",
    },
    {
      id: "engineering-deep-read",
      name: "工科实验精析",
      builtin: true,
      prompt:
        "你是一位工程领域的资深审稿人。请对以下论文做深度精读，重点拆解其工程实现与实验设计。\n\n请按 Markdown 输出，包含以下二级标题：\n1. **研究动机与创新点** — 明确列出与已有工作的差异，逐条说明创新程度。\n2. **实验设计** — 实验平台/装置、样本规模、对照组设置、变量控制方式。\n3. **算法与实现细节** — 关键公式、超参数、复杂度或硬件开销。\n4. **关键数据与误差分析** — 提取核心指标表格，指出误差来源与置信区间（若原文给出）。\n5. **可复现性评估** — 数据/代码是否公开，复现该实验所需的最小条件。\n6. **局限与可改进方向** — 从工程落地角度给出 3 条具体建议。\n\n论文元信息：标题《{{title}}》，作者：{{creators}}，年份：{{year}}，期刊/会议：{{publication}}。\n\n论文全文：\n{{content}}",
    },
  ])
);
