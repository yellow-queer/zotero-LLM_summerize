import { TimeoutError, withTimeout } from "../utils/abort";
import { log, logError } from "../utils/env";
import { getString } from "../utils/l10n";
import {
  DEFAULT_PROMPT_TEMPLATES,
  PrefKey,
  PromptTemplate,
  cloneDefaults,
  fullPrefKey,
  getPromptTemplates,
  setPromptTemplates,
} from "../utils/prefs";

/**
 * Zotero 7 preference pane controller.
 *
 * Registration goes through `Zotero.PreferencePanes.register()`; the Zotero 6
 * `<prefwindow>` / XUL overlay mechanism no longer exists. Zotero loads `src` as
 * a *fragment* (XUL default namespace, HTML under `html:`) and afterwards
 * activates every element carrying a `preference="<full.pref.key>"` attribute —
 * see `_initImportedNodesPostInsert()` in Zotero's
 * `chrome/content/zotero/preferences/preferences.js`. That binding is
 * bidirectional, so the plain fields need no JavaScript at all.
 *
 * Only what the `preference` binding cannot express is implemented here:
 *   - the variable-length Prompt template list;
 *   - the "test connection" probe;
 *   - localised labels, applied post-load because Fluent cannot format a plugin
 *     string before Zotero has registered the plugin's locale resources.
 */

const CONNECTION_TEST_TIMEOUT_MS = 20_000;

/**
 * Label element suffix → [Fluent message id, fallback text].
 *
 * Suffixes match the `<html:label>` / `<html:h2>` ids in `preferences.xhtml`:
 * `zotero-prefpane-llmsummarizer-<suffix>`. Buttons keep their `label=`
 * attributes in the markup instead of being listed here.
 */
const LABELS: Record<string, [string, string]> = {
  "api-section": ["pref-api-section", "模型接口"],
  provider: ["pref-provider", "服务商预设"],
  baseurl: ["pref-baseurl", "API Base URL"],
  apikey: ["pref-apikey", "API Key"],
  model: ["pref-model", "Model Name"],
  temperature: ["pref-temperature", "Temperature"],
  maxchars: ["pref-maxchars", "最大字符数"],
  timeout: ["pref-timeout", "超时时间（秒）"],
  language: ["pref-language", "输出语言"],
  debug: ["pref-debug", "输出调试日志"],
  "prompt-section": ["pref-prompt-section", "Prompt 模板库"],
  "prompt-name": ["pref-prompt-name", "模板名称"],
  "prompt-body": ["pref-prompt-body", "模板内容"],
  help: [
    "pref-help",
    "可用占位符：{{content}} 论文全文、{{title}} 标题、{{creators}} 作者、{{year}} 年份、{{publication}} 期刊或会议名称。",
  ],
};

/** Preset endpoints, applied to the Base URL field by the dropdown. */
const PROVIDER_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  dashscope: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  custom: { baseUrl: "", model: "" },
};

export class PreferencePane {
  private readonly addonRef: string;
  private readonly pluginID: string;

  constructor(addonRef: string, pluginID: string) {
    this.addonRef = addonRef;
    this.pluginID = pluginID;
    this.register();
  }

  private register(): void {
    // `rootURI` is published by bootstrap.js on the sandbox global; `src` and
    // `stylesheets` must be absolute `moz-extension://` URLs.
    const rootURI = String((_globalThis as { rootURI?: string }).rootURI ?? "");

    Zotero.PreferencePanes.register({
      pluginID: this.pluginID,
      src: `${rootURI}content/preferences.xhtml`,
      id: `zotero-prefpane-${this.addonRef}`,
      label: "LLM Summarizer",
      // Resolved through the chrome namespace registered in bootstrap.js.
      image: `chrome://${this.addonRef}/content/icons/favicon.svg`,
      stylesheets: [`${rootURI}content/preferences.css`],
    }).catch(logError);
  }

  /**
   * Entry point for the inline handlers in `preferences.xhtml`.
   *
   * Inline attributes are evaluated against the *preferences window*, so they
   * reach this object through the global plugin instance
   * (`Zotero.LLMSummarizer.hooks.onPrefsEvent(...)`). Internally the pane calls
   * its own methods directly.
   */
  async onPrefsEvent(
    type: string,
    data: { window?: Window; id?: string; [key: string]: unknown } = {},
  ): Promise<void> {
    const window = data.window;
    try {
      switch (type) {
        case "load":
          await this.onPaneLoad(window);
          break;
        case "providerChange":
          await this.onProviderChange(window, data as { value?: string });
          break;
        case "testConnection":
          await this.onTestConnection(window);
          break;
        case "selectTemplate":
          this.onSelectTemplate(window, data);
          break;
        case "addTemplate":
          this.onAddTemplate(window);
          break;
        case "saveTemplate":
          this.onSaveTemplate(window);
          break;
        case "deleteTemplate":
          this.onDeleteTemplate(window);
          break;
        case "resetTemplates":
          this.onResetTemplates(window);
          break;
        case "refreshPrompts":
          this.renderTemplateList(window);
          break;
        default:
          log(`Unhandled prefs event: ${type}`);
      }
    } catch (e) {
      logError(e);
      this.setStatus(window, e instanceof Error ? e.message : String(e), "error");
    }
  }

  // -------------------------------------------------------------------- load

  private async onPaneLoad(window?: Window): Promise<void> {
    if (!window) {
      return;
    }

    for (const suffix of Object.keys(LABELS)) {
      const [messageId, fallback] = LABELS[suffix];
      const element = this.el(window, suffix);
      if (element) {
        element.textContent = await getString(messageId, fallback);
      }
    }

    this.renderTemplateList(window);
    this.setStatus(window, "", "idle");
  }

  /** Looks up a label, button or container by its pane id suffix. */
  private el<K extends Element = HTMLElement>(window: Window, suffix: string): K | null {
    return window.document.getElementById(
      `zotero-prefpane-${this.addonRef}-${suffix}`,
    ) as K | null;
  }

  /** Looks up an input control: the `-input` suffix is part of the id scheme. */
  private field<K extends Element = HTMLInputElement>(window: Window, suffix: string): K | null {
    return this.el<K>(window, `${suffix}-input`);
  }

  /** Applies a provider preset to the Base URL and Model fields. */
  private async onProviderChange(window?: Window, data: { value?: string } = {}): Promise<void> {
    if (!window) {
      return;
    }
    const preset = PROVIDER_PRESETS[data.value ?? ""];
    if (!preset || !preset.baseUrl) {
      return;
    }
    // Setting `.value` alone would not persist: the pane's `preference` binding
    // only writes a pref in response to 'input'/'change', so dispatch one.
    for (const [suffix, value] of [
      ["baseurl", preset.baseUrl],
      ["model", preset.model],
    ] as const) {
      const field = this.field<HTMLInputElement>(window, suffix);
      if (field) {
        field.value = value;
        // The event must be created from the *preferences window's* realm: the
        // `preference` binding listens on that document.
        field.dispatchEvent(new window.Event("input", { bubbles: true }));
      }
    }
  }

  // --------------------------------------------------------------- templates

  /** Renders the clickable list of templates next to the editor. */
  private renderTemplateList(window?: Window): void {
    if (!window) {
      return;
    }
    const list = this.el<HTMLElement>(window, "prompt-list");
    if (!list) {
      return;
    }

    const templates = getPromptTemplates();
    const doc = window.document;

    list.replaceChildren(
      ...templates.map((template, index) => {
        // The pane fragment lives in a document whose default namespace is XUL,
        // so HTML elements must be created with an explicit namespace.
        const element = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "div",
        ) as HTMLElement;
        element.className = "prompt-list-item";
        element.id = `zotero-prefpane-${this.addonRef}-prompt-item-${template.id}`;
        element.textContent = template.name;
        element.dataset.templateId = template.id;
        if (index === 0) {
          element.classList.add("selected");
        }
        element.addEventListener("click", () => this.onSelectTemplate(window, { id: template.id }));
        return element;
      }),
    );

    this.onSelectTemplate(window, { id: templates[0]?.id });
  }

  private onSelectTemplate(window?: Window, data: { id?: string } = {}): void {
    if (!window) {
      return;
    }
    const templates = getPromptTemplates();
    const template = templates.find((t) => t.id === data.id) ?? templates[0];
    if (!template) {
      return;
    }

    const nameField = this.field<HTMLInputElement>(window, "prompt-name");
    const bodyField = this.field<HTMLTextAreaElement>(window, "prompt-body");
    const deleteButton = this.el<HTMLButtonElement>(window, "prompt-delete");
    const editor = this.el<HTMLElement>(window, "prompt-editor");

    if (nameField) {
      nameField.value = template.name;
    }
    if (bodyField) {
      bodyField.value = template.prompt;
    }
    if (deleteButton) {
      // Built-ins are the recovery path after a wiped library, so they are
      // protected rather than hidden.
      deleteButton.disabled = Boolean(template.builtin);
    }
    if (editor) {
      editor.dataset.templateId = template.id;
    }

    const prefix = `zotero-prefpane-${this.addonRef}-prompt-item-`;
    for (const element of Array.from(window.document.querySelectorAll(".prompt-list-item"))) {
      element.classList.toggle("selected", element.id === prefix + template.id);
    }
  }

  private onAddTemplate(window?: Window): void {
    if (!window) {
      return;
    }
    const templates = getPromptTemplates();
    const created: PromptTemplate = {
      id: `custom-${Date.now().toString(36)}`,
      name: `自定义模板 ${templates.length + 1}`,
      prompt: "请阅读以下论文全文，并输出结构化的中文研读笔记。\n\n{{content}}",
    };
    setPromptTemplates([created, ...templates]);
    this.renderTemplateList(window);
    this.onSelectTemplate(window, { id: created.id });
    this.setStatus(window, "已新建模板，填写名称与内容后点击「保存模板」。", "ok");
  }

  private onSaveTemplate(window?: Window): void {
    if (!window) {
      return;
    }
    const templateId = this.el<HTMLElement>(window, "prompt-editor")?.dataset.templateId;
    if (!templateId) {
      return;
    }

    const name = (this.field<HTMLInputElement>(window, "prompt-name")?.value ?? "").trim();
    const prompt = this.field<HTMLTextAreaElement>(window, "prompt-body")?.value ?? "";

    if (!name) {
      this.setStatus(window, "模板名称不能为空。", "error");
      return;
    }
    if (!prompt.trim()) {
      this.setStatus(window, "模板内容不能为空。", "error");
      return;
    }

    const templates = getPromptTemplates();
    const index = templates.findIndex((t) => t.id === templateId);
    if (index === -1) {
      return;
    }
    templates[index] = { ...templates[index], name, prompt };
    setPromptTemplates(templates);

    this.renderTemplateList(window);
    this.onSelectTemplate(window, { id: templateId });
    this.setStatus(window, `已保存模板「${name}」。右键菜单会立即使用新内容。`, "ok");
  }

  private onDeleteTemplate(window?: Window): void {
    if (!window) {
      return;
    }
    const templateId = this.el<HTMLElement>(window, "prompt-editor")?.dataset.templateId;
    if (!templateId) {
      return;
    }

    const templates = getPromptTemplates();
    const target = templates.find((t) => t.id === templateId);
    if (!target) {
      return;
    }
    if (target.builtin) {
      this.setStatus(window, "预设模板不可删除；如需修改，请编辑后另存为新模板。", "error");
      return;
    }
    if (templates.length <= 1) {
      this.setStatus(window, "至少需要保留一个模板。", "error");
      return;
    }

    setPromptTemplates(templates.filter((t) => t.id !== templateId));
    this.renderTemplateList(window);
    this.setStatus(window, `已删除模板「${target.name}」。`, "ok");
  }

  private onResetTemplates(window?: Window): void {
    if (!window) {
      return;
    }
    setPromptTemplates(cloneDefaults());
    this.renderTemplateList(window);
    this.setStatus(
      window,
      `已恢复 ${DEFAULT_PROMPT_TEMPLATES.length} 个预设模板，自定义模板已清除。`,
      "ok",
    );
  }

  // -------------------------------------------------------------------- test

  /**
   * Probes the configured endpoint with a 1-token request so users can validate
   * Base URL / Key / Model before paying for a real summary.
   *
   * A bare `fetch` is used instead of `chatCompletion()` on purpose: the test
   * must report the raw status code, whereas `chatCompletion()` converts
   * failures into user-facing prose.
   */
  private async onTestConnection(window?: Window): Promise<void> {
    if (!window) {
      return;
    }
    // Read raw values (no fallbacks) so the test reports what is actually
    // configured. `fullPrefKey` is required — a short name with `global = true`
    // would read a root-level pref instead of this plugin's.
    const readPref = (key: PrefKey): string =>
      String(Zotero.Prefs.get(fullPrefKey(key), true) ?? "").trim();

    const baseUrl = readPref("apiBaseUrl");
    const apiKey = readPref("apiKey");
    const model = readPref("modelName");

    if (!baseUrl || !model) {
      this.setStatus(window, "请先填写 Base URL 与 Model Name。", "error");
      return;
    }

    const normalized = baseUrl.replace(/\/+$/, "");
    const url = /\/chat\/completions$/.test(normalized)
      ? normalized
      : `${normalized}/chat/completions`;

    const button = this.el<Element & { disabled: boolean }>(window, "test");
    if (button) {
      button.disabled = true;
    }
    this.setStatus(window, "正在测试连接…", "idle");

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      // Same sandbox restriction as llmClient — see src/utils/abort.ts.
      const response = await withTimeout(
        (signal) =>
          fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
            }),
            signal: signal ?? null,
          }),
        CONNECTION_TEST_TIMEOUT_MS,
      );

      this.setStatus(
        window,
        response.ok
          ? `连接成功（HTTP ${response.status}），配置可用。`
          : `连接失败：HTTP ${response.status} ${response.statusText}`,
        response.ok ? "ok" : "error",
      );
    } catch (e) {
      this.setStatus(
        window,
        e instanceof TimeoutError
          ? `请求超时（${CONNECTION_TEST_TIMEOUT_MS / 1000} 秒），请检查 Base URL 是否可访问。`
          : `无法连接：${String(e)}`,
        "error",
      );
    } finally {
      if (button) {
        button.disabled = false;
      }
    }
  }

  // ------------------------------------------------------------------ status

  private setStatus(
    window: Window | undefined,
    message: string,
    kind: "ok" | "error" | "idle",
  ): void {
    if (!window) {
      return;
    }
    const status = this.el<HTMLElement>(window, "status");
    if (!status) {
      return;
    }
    status.textContent = message;
    status.className = `status status-${kind}`;
    if (kind === "ok") {
      // Clear the confirmation so it cannot be mistaken for a live error later.
      window.setTimeout(() => {
        if (status.textContent === message) {
          status.textContent = "";
          status.className = "status status-idle";
        }
      }, 4000);
    }
  }

  unregister(): void {
    Zotero.PreferencePanes.unregister(`zotero-prefpane-${this.addonRef}`);
  }
}
