# Zotero LLM Summarizer

Zotero 7+ 插件：在文献条目或 PDF 附件上右键，一键调用兼容 OpenAI 规范的大模型，把论文全文变成挂在条目下的富文本子笔记。

- 运行时零第三方依赖：HTTP 用全局 `fetch`，PDF 文本用 Zotero 内置全文索引（pdf.js）。
- 构建期只需 `esbuild` + `typescript`。
- 产物：`build/zotero-llm-summarizer.xpi`（标准 ZIP）。

---

## 1. 构建与安装

```bash
npm install
npm run build     # 类型检查 + 打包，产出 build/zotero-llm-summarizer.xpi
```

在 Zotero 中安装：

1. **工具 → 插件**，右上角齿轮 ⚙ → **Install Add-on From File…**
2. 选择 `build/zotero-llm-summarizer.xpi`
3. 到 **编辑 → 设置 → LLM Summarizer** 填接口信息

无需签名（Zotero 不像 Firefox 强制校验签名），`.xpi` 可直接从文件安装。

> 重新构建后要重装：插件页点 **Remove** 再装，或齿轮菜单里的 **Reload**（仅开发期可见）。Zotero 缓存插件文件，覆盖 `.xpi` 不会热更新。

### 其它命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 类型检查 + 打包 |
| `npm run release <patch\|minor\|major\|x.y.z>` | 递增版本 → 构建 → 核对产物版本号 |
| `npm run typecheck` | 只跑 `tsc --noEmit` |
| `npm test` | 运行纯逻辑自测（Markdown 转换、截断、Prompt 拼装、首选项键名等） |
| `npm run icons` | 重新生成 PNG 图标 |

### 联调（改代码即时看效果）

让 Zotero 直接从源码目录加载，省掉每次打包：

1. 把 `t/build/addon` 软链接到 Zotero 的插件目录，**目录名必须等于 manifest 里的 `id`**：
   - Windows：`%APPDATA%\Zotero\Zotero\Profiles\<profile>\extensions\llm-summarizer@yourdomain.org`（用 `mklink /D`）
   - macOS / Linux：`~/.zotero/zotero/<profile>/extensions/llm-summarizer@yourdomain.org`
2. **帮助 → Debug Output Logging → Enable**，勾选 **View Output**。
3. 改完代码跑 `npm run build`，然后在插件页点 **Reload**。

插件日志前缀是 `[LLMSummarizer]`，可在输出窗口里过滤。打开 **设置 → LLMSummarizer → 输出调试日志** 会额外打印异常对象与结构化数据。

---

## 2. 使用方式

1. 选中**一篇文献条目**，或**它下面的 PDF 附件**（支持多选）。
2. 右键 → **AI 文献总结** → 选择 Prompt 模板。
3. 右下角进度窗口依次显示「提取文本 → 呼叫大模型 → 写入笔记」。
4. 完成后自动选中新生成的笔记。

笔记固定挂在**顶级文献条目**下（Zotero 的数据模型里 PDF 与笔记是兄弟关系）；选中 PDF 时会自动向上找到 `parentItem`。选中的条目里没有可解析的 PDF 时，菜单项置灰并给出 tooltip 说明原因。

**在 Zotero 里跑临时代码：** 工具 → 开发者 → Run JavaScript，*Run as async function* 模式下可直接调用运行时对象，排查问题时很有用：

```js
Zotero.LLMSummarizer?.hooks;                    // undefined 表示 bootstrap 没跑起来
Zotero.Prefs.get("extensions.zotero.llmsummarizer.modelName", true);
```

---

## 3. 配置项

**编辑 → 设置 → LLM Summarizer**（macOS 上是 **Zotero → 设置**）。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| API Base URL | `https://api.deepseek.com/v1` | 填到 `/v1` 即可，插件自动补 `/chat/completions` |
| API Key | 空 | 密码框；仅本地推理服务可留空 |
| Model Name | `deepseek-chat` | 透传给接口的 `model` 字段 |
| Temperature | `0.3` | 摘要任务偏低更稳 |
| 最大字符数 | `25000` | 超过则按前 60% / 后 40% 截断 |
| 超时（秒） | `60` | 请求时限 |
| 输出语言 | `zh-CN` | 非 `zh-CN` 时会在 Prompt 末尾追加语言要求 |

### 常见服务商

| 服务 | Base URL | Model Name |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` | `moonshot-v1-32k` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5:14b` |
| LM Studio（本地） | `http://localhost:1234/v1` | 以界面显示为准 |

Base URL 命中 `localhost` / `127.0.0.1` / `0.0.0.0` / `[::1]` 时视为本地服务，**不要求填 API Key**。

### Prompt 模板库

内置两个预设：**通用研读总结**（背景与问题 / 核心方法 / 主要结果 / 结论与局限）、**工科实验精析**（动机与创新点 / 实验设计 / 算法细节 / 关键数据与误差 / 可复现性 / 改进方向）。

可在设置页新增、编辑、删除模板，改动即时反映到右键子菜单（菜单每次展开都重新读取，不缓存）。

| 占位符 | 含义 |
| --- | --- |
| `{{content}}` | 论文全文（**必填**，缺失时自动附在末尾） |
| `{{title}}` | 标题 |
| `{{creators}}` | 作者，逗号分隔 |
| `{{year}}` / `{{date}}` | 年份 / 完整日期 |
| `{{publication}}` | 期刊或会议名 |
| `{{itemType}}` | Zotero 条目类型 |

写错的占位符会**原样保留**在最终 Prompt 里，方便在 Debug Output 中看出笔误，而不是被静默替换成空串。

---

## 4. 分发与更新

把 `build/zotero-llm-summarizer.xpi` 发给别人（或传到 GitHub Releases），对方用同样的「Install Add-on From File…」装进去，再填自己的 API Key。**无需对方装 Node.js。**

发布前先在 `package.json` 的 `config` 里改两处：

| 字段 | 默认值 | 为什么 |
| --- | --- | --- |
| `addonID` | `llm-summarizer@yourdomain.org` | 插件唯一标识。**一旦有人装了就别再改** —— 改了等于换了个新插件，老用户收不到更新。 |
| `updateURL` | 指向 `github.com/yourname/…` | 自动更新元数据地址。指向不存在的地址不会导致安装失败，但每次检查更新都会失败。 |

本项目当前用 GitHub Releases 托管，`updateURL` 指向：

```text
https://github.com/yellow-queer/zotero-LLM_summerize/releases/latest/download/updates.json
```

**发新版本只需一条命令：**

```bash
npm run release patch     # 或 minor / major / 明确的 x.y.z
```

它递增 `package.json` 版本、重新构建，并回读 `build/updates.json` 确认 Zotero 看到的确实是新版本号。之所以做成脚本，是因为漏掉递增**不会报错** —— 构建、上传都成功，用户那边毫无变化。

然后把**两个文件**作为 release 附件上传（**必须都传、不能改名**）：

| 附件 | 作用 |
| --- | --- |
| `build/zotero-llm-summarizer.xpi` | 用户下载安装 |
| `build/updates.json` | 已安装用户检查更新 |

`updates.json` 里的 `update_hash` 是**那一次构建**产出的 `.xpi` 的 SHA-256，构建脚本每次重新计算 —— 不要手工维护，也不要只替换其中一个，否则校验失败、更新被丢弃。

`releases/latest/download/<文件名>` 会自动解析到最新一个**已发布**的 release，所以地址永远不变。三个容易踩的点：

- **草稿（Draft）和预发布（Pre-release）不算「latest」** —— 标成预发布后 `releases/latest/...` 会跳到上一个正式版，用户收不到更新。
- **不要给附件加登录、防盗链或私有仓库权限。** 更新检查走匿名请求（`mozAnon: true`，不带 Cookie），被挡下不报错，只是永远收不到更新。私有仓库的 Release 附件因此**不能用于分发**。
- **发布产物不要提交进源码仓库。** `.gitignore` 里已有 `build/` 和 `*.xpi`，保持这样 —— 仓库里一份过期的 `.xpi` 只会让人下载到旧版。

> 换别的托管（自己的网站、Cloudflare Pages）也可以：把两个文件放到任意公开目录，把 `config.updateURL` 指向那里的 `updates.json`。不要求 CORS 响应头（更新检查走特权 XHR）。

**两个会让用户收不到更新的坑：**

- **`strict_min_version` 是更新门槛。** 用户的 Zotero 低于它时该更新不会被应用（Zotero 强制检查 min/max，不像 Firefox 可以放宽）。
- **安装方式决定更新体验。** 「Install Add-on From File…」装的是用户主动安装，更新正常；手动把 `.xpi` 丢进 profile 的 `extensions/` 目录属于 sideload，会被 Zotero **自动禁用**。分发给用户时务必让他们走安装界面。

**确认是否生效：** 工具 → 插件 里版本号变化即成功。齿轮菜单 → **Check for Updates** 可手动强制检查。

---

## 5. 代码结构

```text
src/
  index.ts                 插件入口：生命周期钩子、全局实例安装
  modules/
    menuManager.ts         右键菜单注入、批量调度、ProgressWindow 状态反馈
    textExtractor.ts       PDF 合法性校验 + 全文提取 + 清理 + 60/40 截断
    llmClient.ts           fetch POST、请求超时、HTTP 错误人话化
    noteManager.ts         子笔记创建、挂载层级规范化、Markdown → Note HTML
    markdown.ts            手写 Markdown → HTML（标题/列表/粗体/代码/表格）
    promptLibrary.ts       占位符替换、书目变量收集
    preference.ts          设置面板注册与内联事件分发
  utils/
    abort.ts               沙箱兼容的超时与 AbortController 取用
    prefs.ts               首选项读写 + 默认值兜底
    env.ts / l10n.ts       日志封装 / Fluent 本地化
addon/
  manifest.json            Zotero 7 清单（构建时替换占位符）
  bootstrap.js             生命周期入口，由 Zotero 直接加载
  prefs.js                 默认首选项
  content/                 设置面板（XHTML 片段）+ 图标
  locale/{zh-CN,en-US}/    Fluent 本地化
scripts/
  build.mjs                esbuild 打包 + ZIP 写入
  release.mjs              递增版本 + 构建 + 核对版本号
  make-icons.mjs           零依赖 PNG 生成
  selftest.ts              纯逻辑自测
typings/                   Zotero 全局命名空间与 DOM 补充声明
```

### 改动前值得知道的几件事

源码里每处与 Zotero 底层 API 的交互都写了注释，这里只列最容易踩的：

- **`Zotero.Prefs.get(name, true)` 的 `name` 必须是全名**（`extensions.zotero.llmsummarizer.*`），只有省略第二参数时才会自动补前缀。`preference="..."` 属性同样要求全名。两处必须一致，否则面板写入的值代码读不到，**所有配置静默回落到默认值**。前缀由 `scripts/build.mjs` 通过 esbuild `define` 注入，两边共用一个来源。
- **Gecko 首选项没有浮点类型**，只有 bool / int / string。`pref("temperature", 0.3)` 会被静默截断成 `0`，所以 temperature 以字符串存储，读取时用 `Number()` 解析。
- **插件沙箱里没有 `AbortController`**（`fetch` 在，它不在），`new AbortController()` 会抛 `ReferenceError`。取窗口借控制器时也有顺序讲究：Windows/Linux 上「总是有」的是主窗口，`hiddenDOMWindow` 是 macOS 专属，在 Windows 上读它会抛 `NS_ERROR_FAILURE`。所以 `src/utils/abort.ts` 的设计原则是**超时绝不依赖 `AbortController` 存在**，取不到就退回 `setTimeout` 兜底。
- **笔记只能挂在「常规条目」下**，独立 PDF 不行（Zotero 会抛 `must be a regular item`）。且 `item.topLevelItem` 在没有父条目时**返回它自己**而不是 `null`，`topLevelItem ?? item` 永远回退不到第二项。`noteManager.ts` 的 `resolveNoteTarget()` 因此显式判断 `isRegularItem()`。
- **`saveTx()` 失败时一定会 reject** —— `errorHandler` 拦不住。写笔记必须用 `try/catch`，否则用户看到的是原始异常而不是准备好的提示。
- **`applications.zotero.update_url` 是必需字段**，缺了插件根本不加载，且「插件」窗口里看不到任何解释。`strict_max_version` 同理会被**强制执行**，所以本项目用 `*`。
- **`popupshowing` 会冒泡**：挂在 `#zotero-itemmenu` 上的处理器也会收到嵌套子菜单的事件，不判断 `event.target !== event.currentTarget` 就直接重建菜单，会导致子菜单高频闪烁且永远打不开。
- **菜单没有图标可用**：Zotero 对 `#zotero-itemmenu` 内的菜单项强制 `list-style-image: none !important`，且系统字体栈不含 emoji 字体。菜单标题因此使用纯文字。

---

## 6. 已知边界

- **仅 PDF。** 扫描件（无文字层）会提示需要先 OCR；Word 等格式暂不支持。
- **单次请求不分段。** 超长论文按前 60% / 后 40% 截断（中间插入省略标记），不做多轮 map-reduce —— 摘要、引言、结论的信息密度最高。
- **不自动重试。** 401 / 429 / 5xx 翻译成中文提示后直接失败，避免在用户不知情的情况下重复计费。
- **API Key 以明文存于 Zotero 首选项**（同 Zotero 自身对同步凭据的处理方式）。请勿在共享配置文件的机器上使用生产密钥。

---

## 7. 许可

AGPL-3.0-or-later
