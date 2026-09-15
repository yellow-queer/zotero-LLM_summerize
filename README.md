# Zotero LLM Summarizer

Zotero 7+ 插件：在条目或 PDF 附件上右键，一键调用兼容 OpenAI 规范的大模型，把论文全文变成一篇挂在条目下的富文本子笔记。

- 目标平台：**Zotero 7 及以上**（Firefox 102+ ESR / ESM 沙箱），不使用任何 Zotero 6 的 XUL Overlay 机制。
- 依赖：运行时零第三方库（HTTP 用全局 `fetch`，PDF 文本用 Zotero 内置的全文索引 / `pdf.js`）。构建期只有 `esbuild` + `typescript`。
- 产物：`build/zotero-llm-summarizer.xpi`（标准 ZIP 结构）。

---

## 1. 快速开始：构建与安装

```bash
npm install          # 只装 esbuild / typescript / @types/node
npm run build        # 类型检查 + 打包，产出 build/zotero-llm-summarizer.xpi
```

`npm run build` 实际做这几件事：

1. `tsc --noEmit` —— 严格模式类型检查，**不产出** `.js`（源码只经由 esbuild 编译）。
2. `esbuild` 把 `src/index.ts` 连同全部模块打成单个 IIFE（`target=firefox115`），输出到 `build/addon/content/scripts/llmsummarizer.js`。
3. `scripts/build.mjs` 把 `addon/` 整目录 stage 到 `build/addon/`，替换 `manifest.json` / `bootstrap.js` / `locale/*.ftl` 里的 `__addonName__`、`__addonID__`、`__addonInstance__` 等占位符，同时把 `prefs.js` 里的短名补成 `extensions.zotero.llmsummarizer.*` 全名。
4. 校验 staged 的 `manifest.json`：`applications.zotero` 下 `id` / `update_url` / `strict_max_version` 缺任何一个就直接让构建失败（原因见上文「与 Zotero 7 底层 API 交互的关键点」）。打包前失败，好过发布后插件根本装不上。
5. 手写 ZIP 中央目录得到 `.xpi`，并顺带生成 `build/updates.json`（自动更新用的元数据，含本次 `.xpi` 的 SHA-256）。

其它命令：

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 类型检查 + 打包出 `build/zotero-llm-summarizer.xpi` 与 `build/updates.json` |
| `npm run release <patch\|minor\|major\|x.y.z>` | 递增版本 → 构建 → 核对产物版本号，并打印待发布文件 |
| `npm run typecheck` | 只跑 `tsc --noEmit` |
| `npm test` | 运行纯逻辑自测（Markdown 转换、截断、Prompt 拼装、URL 归一化、首选项键名与类型、菜单事件守卫、AbortController 取用与超时兜底），115 项断言 |
| `npm run icons` | 重新生成 `addon/content/icons/` 下的 PNG 图标（无第三方图像库） |

### 在 Zotero 中安装

1. 打开 Zotero → **工具 (Tools) → 插件 (Add-ons)**。
2. 右上角齿轮 ⚙ → **Install Add-on From File…** → 选择 `build/zotero-llm-summarizer.xpi`。
3. 首次安装后到 **编辑 → 设置 → LLM Summarizer** 填写接口信息（见第 3 节）。

`.xpi` 就是一个普通 ZIP，manifest 的 `strict_min_version` 是 `7.0`、`strict_max_version` 是 `*`，因此 Zotero 7 及之后的版本都能装（已在 **Zotero 10.0.2 / Gecko 140** 上核对过本插件用到的全部 API）。**不需要签名**：Zotero 不像 Firefox 那样强制校验插件签名，未签名的 `.xpi` 可以直接从文件安装 —— 这也是所有第三方 Zotero 插件的通行做法。

> 重新构建后需要重装：在插件页点 **Remove** 再装一次，或点 **Reload**（齿轮菜单里，仅开发期可见）。Zotero 会缓存插件文件，直接覆盖 `.xpi` 不会热更新。

### 分发给其他用户

把 `build/zotero-llm-summarizer.xpi` 发给别人（或传到 GitHub Releases），对方用上面同样的「Install Add-on From File…」装进去，再到设置页填自己的 API Key 即可。**无需重新编译**，也不需要对方装 Node.js。

发布前有两处要先改，都在 `package.json` 的 `config` 里：

| 字段 | 默认值 | 为什么必须改 |
| --- | --- | --- |
| `addonID` | `llm-summarizer@yourdomain.org` | 插件的唯一标识。两个不同插件用同一个 ID 会互相顶掉；Zotero 也用它来关联更新。**一旦有人装了就别再改** —— 改了等于换了个新插件，老用户不会收到更新。 |
| `updateURL` | 指向 `github.com/yourname/…` | `applications.zotero.update_url` 的取值（见下文）。指向不存在的地址不会导致安装失败，但 Zotero 每次检查更新都会失败。 |

改完跑一次 `npm run build`，会多产出一个 `build/updates.json`：

```text
build/zotero-llm-summarizer.xpi    ← 给别人下载
build/updates.json                 ← 自动更新的元数据
```

把这两个文件按 `updateURL` 指向的路径放在一起（默认约定是 GitHub Release 的同一目录），Zotero 就能通过它发现新版本。`updates.json` 里的 `update_hash` 是本次 `.xpi` 的 SHA-256，由构建脚本每次重新计算 —— 不要手工维护，否则会与实际文件不匹配而导致更新被拒绝。

> 如果暂时不做自动更新，把 `updateURL` 指向任意一个格式正确的 `https://` 地址即可，安装不受影响。

#### 用 GitHub Releases 托管

本项目当前就用这种方式，`updateURL` 指向：

```text
https://github.com/yellow-queer/zotero-LLM_summerize/releases/latest/download/updates.json
```

`npm run release <patch|minor|major>` 跑完后，把**两个文件**作为 release 附件上传：

| 附件 | 作用 |
| --- | --- |
| `build/zotero-llm-summarizer.xpi` | 用户下载安装的文件 |
| `build/updates.json` | 已安装用户检查更新用的元数据 |

操作步骤（GitHub 网页即可，不需要 `gh` 或命令行）：

1. 仓库 → **Releases** → **Draft a new release**；
2. **Choose a tag** 里填一个**新**标签，例如 `v0.1.4` → 创建；
3. 把上面两个文件拖进附件区（**必须都上传，且不能改名**）；
4. **Publish release**。

`releases/latest/download/<文件名>` 会自动解析到**最新一个已发布**的 release，所以这个地址永远不变 —— 不需要每次改 `updateURL`。

两个容易出错的点：

- **草稿（Draft）和预发布（Pre-release）不算「latest」**。标成预发布后 `releases/latest/...` 会跳到上一个正式版，用户就收不到更新了。
- **发布产物不要提交进源码仓库**。`.gitignore` 里已经有 `build/` 和 `*.xpi`，保持这样 —— 仓库里那份过期的 `.xpi` 是个隐患，用户可能下载到旧版。发布只走 Release 附件。

**工程文件不要上传到 release 附件里**：只拖那两个文件。

> 仓库根目录上有一个 `zotero-llm-summarizer.xpi`，提交信息是 `Add files via upload` —— 那是**在 GitHub 网页上拖拽上传**产生的提交。网页上传**绕过 `.gitignore`**，而 `.gitignore` 里已有的 `*.xpi` 也不会让一个已经被跟踪的文件自动取消跟踪。请删掉它（`git rm --cached zotero-llm-summarizer.xpi`，或在网页上删除）：仓库里放一份不受版本管理、也无法自动更新的 `.xpi`，只会让人下载到旧版。

不过要说清楚一个前提：**分发 Zotero 插件无法真正保密源码**。`.xpi` 是个 zip，里面必然包含可执行的 `content/scripts/llmsummarizer.js`（本项目是 esbuild 压缩后的产物，不含 TS 源码和 sourcemap）。压缩只是提高了阅读成本，不是保护措施——任何人解压都能读。真要保护实现，唯一可靠的办法是不公开分发。

> 换用别的托管（自己的网站、Cloudflare Pages 等）也完全可以：把这两个文件放到任意公开目录，把 `config.updateURL` 改成那里的 `updates.json` 地址即可，`update_link` 会自动指向同目录的 `.xpi`。唯一的硬性要求是**匿名可访问**（见下）。

之所以不需要签名、也不需要指定主机，是因为 Zotero 关掉了 Firefox 的这两项限制（见 `defaults/preferences/zotero.js`）：

```js
pref("xpinstall.signatures.required", false);   // 未签名的 xpi 可以安装
pref("xpinstall.whitelist.required", false);    // 允许从任意主机安装
```

所以**不需要签名，也不需要托管在 Mozilla 白名单主机上**。另外更新检查走的是系统权限的特权 XHR（`AddonUpdateChecker.sys.mjs` 的 `ServiceRequest`），**不受 CORS 限制**——服务器不需要配置任何跨域响应头，`Content-Type` 也不影响（它对 `updates.json` 会自己 `overrideMimeType("text/plain")` 再 `JSON.parse`）。

唯一不能违反的是**匿名可访问**：请求带 `mozAnon: true`，不带 Cookie，所以别给这两个文件加登录、防盗链或私有仓库权限。被挡下不会报错，只是永远收不到更新。

> 推论：**私有仓库的 Release 附件不能用于分发** —— 匿名请求拿不到。源码要私有的话，得换自己的网站或另建一个公开仓库。

#### 发布新版本：让已安装用户自动更新

Zotero 默认就会检查并**自动安装**插件更新，用户不需要做任何操作：

| 首选项 | 默认值 | 含义 |
| --- | --- | --- |
| `extensions.update.enabled` | `true` | 启用插件更新检查 |
| `extensions.update.autoUpdateDefault` | `true` | 发现新版本后自动下载并安装 |
| `extensions.update.interval` | `86400` | 检查间隔 24 小时（此外每次启动会检查一次） |

Zotero 的取用路径是：清单里的 `applications.zotero.update_url` → 下载 `updates.json` → 用 `Services.vc.compare` 比对版本 → 下载 `update_link` → 用 `update_hash` 校验 SHA-256。清单里的 `update_url` **优先于** Zotero 内置的 AMO 全局地址，所以整条链路完全由你控制。

**每次发布就一条命令：**

```bash
npm run release patch     # 或 minor / major / 明确的 x.y.z
```

它会递增 `package.json` 的版本、重新构建，最后**回读** `build/updates.json` 确认 Zotero 将看到的确实是新版本号，然后打印待发布的两个文件名。

这一步之所以做成脚本，是因为漏掉递增**不会报错**：构建成功、上传成功、任何用户那边都毫无变化 —— `updates.json` 里的版本号原样取自 `package.json`，版本不递增时 Zotero 判定「无更新」。把递增变成构建的一部分，是这个流程里唯一能防住它的办法。（版本号只接受 `x.y.z`：带 `-beta.1` 这类后缀的预发布版在 Mozilla 的版本比较规则下**低于**它所对应的正式版，很容易发出一个「人看着更新、更新器看着更旧」的包。）

然后把 `build/zotero-llm-summarizer.xpi` **和** `build/updates.json` **成对**放到 `updateURL` 指向的目录（GitHub Release 布局下就是同一个 release）。

「成对」是硬要求：`update_hash` 是**那一次构建**产出的 `.xpi` 的 SHA-256，只替换其中一个会让校验失败、更新被丢弃。构建脚本已经保证 `update_link` 与 `updates.json` 同目录，所以不要手工改 `updates.json`。

**两个会让用户收不到更新的坑：**

- **`strict_min_version` 是更新门槛。** 用户的 Zotero 低于它时该更新不会被应用 —— Zotero 强制检查 min/max（见下文 API 要点），不像 Firefox 可以放宽。所以提高它等于「低于该版本的用户从此停在旧版」。
- **安装方式决定更新体验。** Zotero 的 `extensions.autoDisableScopes` 默认 `15`，其中包含 sideload 位：走「Install Add-on From File…」安装的属于用户主动安装，更新正常；而手动把 `.xpi` 丢进 profile 的 `extensions/` 目录的属于 sideload，会被 Zotero **自动禁用**。所以分发给用户时务必让他们走安装界面。

**确认是否生效：** 工具 → 插件 里版本号变化即成功。齿轮菜单 → **Check for Updates** 可手动强制检查（默认节奏无法即时触发）。若检查失败，帮助 → Debug Output 里会有解析 `updates.json` 的报错。

### 联调（改代码即时看效果）

最省事的方式是让 Zotero 直接从源码目录加载，省掉每次重新打包：

1. 建一个指向 `t/build/addon` 的软链接放进 Zotero 的插件目录：
   - Windows：`%APPDATA%\Zotero\Zotero\Profiles\<profile>\extensions\llm-summarizer@yourdomain.org`
     （用 `mklink /D` 创建目录联接，文件名必须等于 manifest 里的 `id`）
   - macOS / Linux：`~/.zotero/zotero/<profile>/extensions/llm-summarizer@yourdomain.org`
2. 在 Zotero 中打开调试输出：**帮助 → Debug Output Logging → Enable**，并勾选 **View Output**。
3. 改完代码跑 `npm run build`（只为了重新生成 bundle 与 stage 目录），然后在插件页点 **Reload**。

插件自身的日志前缀是 `[LLMSummarizer]`，可以在 Debug Output 窗口里过滤。单行摘要（Prompt 长度、截断字符数、附件 key 等）始终输出；把 **设置 → LLMSummarizer → 输出调试日志** 打开后，`log()` 附带的异常对象与结构化数据也会一并打印 —— 排查失败原因时打开它。

### 在 Zotero 里跑临时代码

**工具 → 开发者 → Run JavaScript**，在 *Run as async function* 模式下可以直接调用插件的运行时代码，排查问题时很有用：

```js
// 插件是否已启动（undefined 表示 bootstrap 没跑起来）
Zotero.LLMSummarizer?.hooks;

// 验证 PDF 文本提取这条链路本身是否通
const item = Zotero.getActiveZoteroPane().getSelectedItems()[0];
(await item.attachmentText).length;

// 确认当前生效的配置与模板库（模板库是 JSON 字符串）
Zotero.Prefs.get("extensions.zotero.llmsummarizer.modelName", true);
JSON.parse(Zotero.Prefs.get("extensions.zotero.llmsummarizer.promptTemplates", true));
```

> 设置面板里那些按钮（如「测试连接」）依赖面板自身的 DOM，直接 `onPrefsEvent(...)` 调用不会显示结果 —— 它们只在设置窗口里可用。

---

## 2. 使用方式

1. 在条目列表里选中**一篇文献条目**，或**它下面的 PDF 附件**（支持多选）。
2. 右键 → **AI 文献总结** → 选择 Prompt 模板。
3. 右下角弹出进度窗口，依次显示「正在提取文本… → 正在呼叫大模型… → 正在写入笔记…」。
4. 完成后 Zotero 自动选中新生成的笔记。

笔记固定挂在**顶级文献条目**下，而不是 PDF 附件下 —— 这是 Zotero 的数据模型约定（`条目 → 笔记`，PDF 与笔记是兄弟关系）。选中 PDF 右键时，插件会自动向上找到 `parentItem`。

选中的条目里一个可解析的 PDF 都没有时，菜单项会置灰并给出 tooltip 说明原因，而不是静默失败。

---

## 3. 配置项

**编辑 → 设置 → LLM Summarizer**（macOS 上是 **Zotero → 设置**）。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| API Base URL | `https://api.deepseek.com/v1` | 只填到 `/v1` 即可，插件自动补 `/chat/completions`；填完整端点也不会重复拼接 |
| API Key | 空 | 密码框；仅本地推理服务可留空 |
| Model Name | `deepseek-chat` | 透传给接口的 `model` 字段 |
| Temperature | `0.3` | 摘要任务偏低更稳 |
| 最大字符数 | `25000` | 超过则按前 60% / 后 40% 截断 |
| 超时（秒） | `60` | `AbortController` 时限 |
| 输出语言 | `zh-CN` | 非 `zh-CN` 时会在 Prompt 末尾追加语言要求 |

### 常见服务商填法

| 服务 | Base URL | Model Name |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` | `moonshot-v1-32k` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5:14b` |
| LM Studio（本地） | `http://localhost:1234/v1` | 以 LM Studio 界面显示为准 |

Base URL 命中 `localhost` / `127.0.0.1` / `0.0.0.0` / `[::1]` 时视为本地服务，**不要求填 API Key**。

### Prompt 模板库

内置两个预设：

- **通用研读总结** —— 研究背景与问题 / 核心方法 / 主要结果 / 结论与局限。
- **工科实验精析** —— 研究动机与创新点 / 实验设计 / 算法与实现细节 / 关键数据与误差分析 / 可复现性评估 / 局限与可改进方向。

可以在设置页里新增、编辑、删除模板，改动会即时反映到右键子菜单（菜单每次展开都重新读取，不缓存）。

模板占位符：

| 占位符 | 含义 |
| --- | --- |
| `{{content}}` | 论文全文（**必填**，缺失时插件会在末尾自动附上全文） |
| `{{title}}` | 标题 |
| `{{creators}}` | 作者，逗号分隔 |
| `{{year}}` / `{{date}}` | 年份 / 完整日期 |
| `{{publication}}` | 期刊或会议名 |
| `{{itemType}}` | Zotero 条目类型 |

写错的占位符（如 `{{creaters}}`）会**原样保留**在最终 Prompt 里，方便在 Debug Output 中一眼看出笔误，而不是被静默替换成空串。

---

## 4. 代码结构

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
    abort.ts               AbortController 的沙箱兼容获取 + 不依赖它的超时
    prefs.ts               首选项读写 + 默认值兜底 + 模板库 JSON 修复
    env.ts                 日志封装
    l10n.ts                Fluent 本地化
addon/
  manifest.json            Zotero 7 清单（构建时替换占位符）
  bootstrap.js             Zotero 调用的 install/startup/shutdown/…
  prefs.js                 默认首选项（仅首次安装写入）
  content/preferences.xhtml 设置面板（XHTML 片段，非完整文档）
  content/preferences.css
  content/icons/
  locale/{zh-CN,en-US}/
scripts/
  build.mjs                esbuild 打包 + ZIP 写入
  release.mjs              递增版本 + 构建 + 核对 updates.json 里的版本号
  make-icons.mjs           零依赖 PNG 生成
  selftest.ts              纯逻辑自测
typings/
  zotero.d.ts              Zotero 全局命名空间的最小声明
  dom-extras.d.ts          lib.dom 的补充声明
```

### 与 Zotero 7 底层 API 交互的关键点

代码里每处都以注释标出，主要集中在：

- **`addon/bootstrap.js`** —— Zotero 从插件根目录加载 `bootstrap.js`（见 Zotero 的 `xpcom/plugins.js` → `_loadScope()`），并在一个 Gecko 沙箱里调用 `install` / `startup` / `shutdown` / `uninstall` / `onMainWindowLoad` / `onMainWindowUnload`。沙箱里**没有 `window` / `document`**，所以所有 UI 操作都走 `onMainWindowLoad(window)` 拿窗口对象。
- **`Zotero.PreferencePanes.register()`** —— Zotero 7 添加设置面板的唯一途径（旧的 `<prefwindow>` overlay 已移除）。注册的 `src` 会被当作 **XHTML 片段**解析：默认命名空间是 XUL，HTML 元素必须写 `html:` 前缀。
- **`preference="extensions.zotero.llmsummarizer.xxx"`** —— 属性级双向绑定，Zotero 在面板加载时编译它，无需自己写读写代码。面板里的内联 `onload` / `oncommand` 在设置窗口中求值，因此通过 `Zotero.LLMSummarizer.hooks.onPrefsEvent(...)` 回到插件实例。
- **`Zotero.Item.prototype.attachmentText`** —— 异步 getter：已索引时读 `.zotero-ft-cache`，否则走 `Zotero.PDFWorker.getFullText()`（pdf.js）。插件因此不含任何 PDF 解析代码。
- **`Zotero.ProgressWindow` / `ItemProgress`** —— 与内置「抓取元数据」同一套状态组件，无需自绘 UI。
- **笔记标题** —— `note` 类型在 Zotero schema 中 `fields: []`，`setField("title", …)` 会抛错。Zotero 在保存时用 `Zotero.Utilities.Item.noteToTitle()` 从笔记正文的**第一个标题**推导标题，所以模板名是作为 `<h1>` 写进正文的，模型自己写的 `<h1>` 会被降级为 `<h2>`。
- **`saveTx()` 失败时一定会 reject** —— `Zotero.DataObject#save()` 的异常分支先跑 `_recoverFromSaveError()`，随后**无条件 `throw e`**（`xpcom/data/dataObject.js`，`catch` 块末尾那个 `then()` 的倒数第二行）。`errorHandler` 只是被调用一次，用来决定「要不要再走一遍 `Zotero.logError`」，**拦不住 reject**。所以写笔记必须用 `try/catch`：这里曾经按「`errorHandler` 能吞掉异常、失败会被当成功上报」的假设实现，结果 `throw` 先到，用户看到的是「未预期的错误：Parent item … must be a regular item」，而不是准备好的「写入笔记失败：…」。
- **笔记只能挂在「常规条目」下，独立 PDF 不行** —— `Zotero.Item#_saveData` 在父条目不是 regular item 时抛 `Parent item <libraryKey> must be a regular item`（例外只有「笔记下的内嵌图片附件」和「附件下的标注」，见 `xpcom/data/item.js`）。所以「把摘要笔记挂到 PDF 底下」这条路本身是堵死的。更隐蔽的是 `item.topLevelItem` 在**没有父条目时返回它自己**、而不是 `null` —— `topLevelItem ?? item` 这种写法永远回退不到第二项，独立 PDF 于是把自己当成父条目递给了 Zotero。`src/modules/noteManager.ts` 的 `resolveNoteTarget()` 因此显式判断 `topLevelItem.isRegularItem()`；不是 regular 就改走「顶层笔记」，放进 PDF 所在的分类并用 `addRelatedItem()` 建立关联（Zotero 自己的「从标注创建笔记」对独立附件也是这么处理的：`xpcom/editorInstance.js` 里 `parentID` 不传、改传 `collectionID`）。
- **首选项键名必须是全名** —— `Zotero.Prefs.get(name, true)` 把 `name` 当作完整键；只有省略第二参数时才会自动补 `extensions.zotero.`。反过来，`preference="..."` 属性（`_syncFromPref()` → `Zotero.Prefs.get(preference, true)`）同样要求全名，Zotero 对不含 `.` 的值还会打警告。两处必须一致，否则面板写入 `extensions.zotero.llmsummarizer.*`、代码却去读根级的 `apiBaseUrl` —— 结果是**所有配置静默失效并回落到默认值**。前缀由 `scripts/build.mjs` 通过 esbuild `define` 注入（`__prefsPrefix__`），`prefs.js` 里的短名也在同一处补全，两边共用一个来源。
- **Gecko 首选项没有浮点类型** —— 只有 bool / int / string，且 `Zotero.Plugins.setDefaultPrefs()` 会把 JS number 交给 `setIntPref()`。所以 `pref("temperature", 0.3)` 会被静默截断成 `0`。temperature 以字符串存储，由 `getNumberPref()` 用 `Number()` 解析回来。
- **`formatMessages()` 返回的是对象，不是字符串** —— `Localization.formatMessages()` / `formatValues()` 的每个元素是 `L10nMessage`（形如 `{ value, attributes }`），而 `formatValue()` 才直接返回字符串。把前者赋给 `textContent`，页面上就会显示成 **`[object Object]`**。Zotero 自己的代码也是取 `.value` 的（见 `chrome/content/zotero/preferences/preferences.js` 里的 `formatMessages` 处理）。`src/utils/l10n.ts` 因此走 `formatValue()`，并额外对 `.value` 做了一层兜底。
- **条目右键菜单在 Zotero 里是「无图标」设计** —— `#zotero-itemmenu` 内的 `.menu-iconic` / `.menuitem-iconic` 会被样式表强制 `list-style-image: none !important`，所以给菜单项加这两个 class 不生效。同时 Zotero 的 `:root` 字体栈是 `system-ui, -apple-system, sans-serif`，不含任何 emoji 字体 —— 想在菜单里放 emoji 会因字体回退而显示不稳定，故菜单标题使用纯文字。
- **`popupshowing` 会冒泡，菜单必须过滤事件来源** —— 在 `#zotero-itemmenu` 上挂 `popupshowing` 时，事件也会从**嵌套的子 `<menupopup>`** 冒泡上来。若处理器不判断来源就直接重建菜单，用户一悬浮子菜单就会触发重建，把鼠标底下那个元素删掉 —— 表现为子菜单高频闪烁且**永远打不开**。`src/modules/menuManager.ts` 因此在处理前检查 `event.target !== event.currentTarget`。Zotero 自己的插件菜单 API（`xpcom/pluginAPI/menuManager.js`）对每个 `popupshowing` / `command` 监听器都加了同样的守卫。
- **菜单不再手写注入的前提是 Zotero 8** —— Zotero 从 8.0 起提供 `Zotero.MenuManager.registerMenu()`（`xpcom/pluginAPI/menuManager.js`），能自动插入分隔符、在菜单超出屏幕时折叠分组，并在插件卸载时自动清理。因为它不存在于 7.x（`pluginAPI/menuManager.js` 与 `pluginAPIBase.mjs` 在 7.0–7.3 的源码树里都不存在），而本项目声明支持 Zotero 7，所以仍采用手写注入。另需注意该 API 的 `MenuData` **没有 `label` 字段**（只有 `l10nID`/`l10nArgs`，且校验逻辑会静默丢弃未知字段），而 `registerMenu()` 注册的项列表是静态的，与「模板库可由用户随时增删」的需求不合 —— 这也是没有迁移的原因之一。
- **插件沙箱里没有 `AbortController`，而且没有属于自己的 DOM 窗口** —— Zotero 的 `xpcom/plugins.js` → `_loadScope()` 用一份**白名单**（`wantGlobalProperties`）构建插件沙箱：`atob` / `btoa` / `Blob` / `crypto` / `CSS` / `ChromeUtils` / `DOMParser` / `fetch` / `File` / `FileReader` / `TextDecoder` / `TextEncoder` / `URL` / `URLSearchParams` / `XMLHttpRequest`，再加 `setTimeout` 等。**`fetch` 在里面，`AbortController` 不在**，所以任何普通窗口里正常的 `new AbortController()` 在这里抛 `ReferenceError`，而且是在发请求**之前**就抛，整个操作直接失败。

  借窗口这件事有个**很容易搞反的顺序**。`plugins.js:502` 的注释是：*"Use the main window (which we always have on non-macOS), falling back to the hidden window (which we always have on macOS)."* —— **主窗口才是 Windows/Linux 上「总是有」的那个**，`hiddenDOMWindow` 是 macOS 专属；在 Windows 上读它会**抛 `NS_ERROR_FAILURE`**（不是返回 null），所以连访问都得包 `try`。先试 `hiddenDOMWindow` 的写法在 macOS 上能跑、在 Windows 上必崩。

  因此 `src/utils/abort.ts` 的设计原则是：**超时绝不能依赖 `AbortController` 存在**。它按「沙箱全局 → `Zotero.getMainWindow()` → `hiddenDOMWindow`（`try` 包裹）」尽力取一个控制器，取不到就返回 `null`；`withTimeout()` 用沙箱**确实有**的 `setTimeout` 来兜底计时，保证调用方一定被按时解除阻塞。丢掉 socket 是尽力而为，让 Promise 落地不是。
- **`item.itemType` 是 getter，没有 `getItemType()` 方法** —— 这是 `Zotero.defineProperty(Zotero.Item.prototype, 'itemType', …)` 定义的取值器。它的特殊之处在于：因为 `typings/zotero.d.ts` 是我们手写的，**自己编一个不存在的方法也能通过 `tsc`**，只在运行时炸成 `TypeError: getItemType is not a function`，而错误又被 `safeCall()` 吞掉，最终表现为 prompt 里的文献类型**静默变成空字符串**。手写声明时必须核对 `xpcom/data/item.js` 里真实的 `prototype` 定义；`scripts/selftest.ts` 现在用「只有 getter、没有方法」的桩来守住这条。
- **`applications.zotero.update_url` 是必需字段** —— Zotero 改了 toolkit 的 `Extension.sys.mjs`，在 `type == "extension"` 时强制要求 `applications.zotero` 下同时存在 `id`、`update_url`、`strict_max_version`，缺一个就调 `manifestError()` → `packagingError()`。这个函数**只把消息塞进 `errors` 数组、不抛异常**，真正的抛错发生在后面的 `loadManifest()` → `ensureNoErrors()`。结果是插件根本不加载，而「插件」窗口里看不到任何解释。`update_url` 名字看起来像「要不要做自动更新」的可选项，实际是致命的。
- **`strict_max_version` 在 Zotero 里是被强制执行的** —— 与 Firefox 不同（Firefox 默认 `extensions.strictCompatibility = false`，此时只比较 minVersion），Zotero 的 `AddonManager` 里 `gStrictCompatibility` 初始值就是 `true`，且没有在 `greprefs.js` 里覆盖。所以 `maxVersion` 会真的参与比较：写死 `7.*` 会让插件在更高版本上被判定为不兼容，`getActiveAddons()` 直接不返回它，Zotero 连加载都不会加载。本项目因此用 `*`（等同于不限制），这也正是 Zotero 在 `strict_max_version` 缺省时的取值（`app.maxVersion || "*"`）。

### 关于 `manifest.json` 里没有 `background` 字段

`background` 是 WebExtension（Chrome / Firefox MV3）的概念。Zotero 7 的插件是 **bootstrapped extension**：只要插件根目录下存在 `bootstrap.js`，Zotero 就会加载它，manifest 中**不需要也不存在**对应的字段（对比 Zotero 官方的 Make It Red 示例与 `zotero-plugin-template` 的 manifest，两者都没有该字段）。后台逻辑的入口就是 `bootstrap.js` → `startup()` → `content/scripts/llmsummarizer.js`。

---

## 5. 已知边界

- **仅 PDF**。扫描件（无文字层）提取不到文本时会提示需要先 OCR。Word (.docx) 等格式的扩展接口见 `textExtractor.ts` 中的 `ExtractionError` 分支，首期不实现。
- **单次请求不分段**。超长论文按前 60% / 后 40% 截断（中间插入省略标记），不做多轮 map-reduce。原因是摘要任务里摘要、引言、结论的信息密度最高，而中段多为相关工作与证明。
- **不自动重试**。401 / 429 / 5xx 会被翻译成中文提示后直接失败，避免在用户不知情的情况下重复计费。
- **API Key 以明文存于 Zotero 首选项**（同 Zotero 自身对同步凭据的处理方式）。请勿在共享配置文件的机器上使用生产密钥。

---

## 6. 许可

AGPL-3.0-or-later
