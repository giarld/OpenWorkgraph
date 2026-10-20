---
name: openworkgraph-visualize
description: "为万象画布（OpenWorkgraph）编写、修改、打包和校验 Visualize .owgv 文件。用户要求生成可导入的可视化工具、交互页面或编辑已有 .owgv/.owvisualize.json 时使用。面向 Codex、Claude Code 等能够读写文件和执行 Node.js 的 Agent；不用于普通网站或其他产品的 visualize 工具。"
---

# OpenWorkgraph Visualize 文件编写

交付能导入万象画布的真实 `.owgv` 文件。它是包含页面、表单、状态与资源的 JSON 包，不是改后缀的 HTML、ZIP、工作图备份或只含页面的 `page.json`。本技能供 Agent 执行，不是产品内置 Visualize 功能的注册教程。

## 开始编写

将本技能所在目录记为 `SKILL_DIR`，命令使用其实际绝对路径。脚本只需 Node.js 24+，无需工作空间连接、登录或 npm 依赖。

1. 确定工具行为、业务输出和默认值。已有文件先解包；新文件将 `assets/source.json` 与 `assets/tool.html` 复制到工作目录修改。模板是可用的数值换算器，应替换为真实需求。
2. 阅读 [references/owgv-format.md](references/owgv-format.md)；需要交互、保存、输入、信号或导出时阅读 [references/page-sdk.md](references/page-sdk.md)。不依赖其他技能或本项目源码。
3. 在独立 HTML 中实现页面，source JSON 声明 schema、默认值、尺寸、Logo、输入提示和本地资源。不手工转义整段 HTML，不手算 Base64、bytes 或哈希。
4. 打包并校验，条件允许时在实际宿主中验证行为。最终提供 `.owgv` 的绝对路径链接、用途及实际验证范围。

```text
node "<SKILL_DIR>/scripts/owgv.mjs" pack "<工作目录>/source.json" "<输出目录>/tool.owgv"
node "<SKILL_DIR>/scripts/owgv.mjs" validate "<输出目录>/tool.owgv"
```

`pack` 使用随技能携带的 OpenWorkgraph 协议构造器与校验器，计算字节、哈希和包内身份，验证后写入。修改 HTML、JSON 或媒体后重新打包，不只改 base64 或哈希之一。文本统一 UTF-8 无 BOM。

## 编辑已有文件

```text
node "<SKILL_DIR>/scripts/owgv.mjs" unpack "<输入目录>/existing.owgv" "<新的编辑目录>"
```

编辑解包所得 `source.json`、`tool.html` 与 `media/` 后再打包。`snapshot` 保留原表单/状态快照和节点尺寸，常规修改保留它。用户要求恢复默认值或输出空白工具模板时移除 `snapshot`，使用 `page.initialForm/initialState`。修改 schema 时同步调整默认值与保留快照，不能静默丢弃不兼容数据。

新建工具只携带工具默认值。`inputNames` 仅提示重新连接的输入名称；包内 `inputBindings` 为空。禁止携带源工作图身份、连线、运行历史、会话、凭据或模型/技能配置。

## 页面实现约束

- 等待宿主的 `window.visualizeReady` 后调用 `window.visualize`，从 `context.form.data/state.data` 恢复数据。宿主还注入 `visualizeAssetsReady` 和默认样式。
- 业务 JSON 用 `updateForm(fullObject)`，视图状态用 `saveState(fullJson)`，均全量替换。保存和打开页面不执行任务；以确认回执判断成功。
- 输入跟随优先信号/槽，避免轮询。高频状态保存每通道最多一个在途请求和一个最新待保存快照；依赖保存的动作等待确认，不合并明确的导出或执行动作。
- 默认使用宿主语义控件与 `visualize-*` 类，CSS 仅补业务布局、图表或媒体。明确要求自定义风格时才另行设计；“美观/现代”不等于自定义风格。兼容浅深主题、键盘与窄节点。
- 呈现工具本身的操作方式，不重复宿主标题、工作图导航、刷新/展开功能，不附加配置摘要、装饰指标或常驻“已就绪/已保存”标签。
- 不在 HTML/form/state 内嵌媒体 Base64 或 data URL，使用声明依赖和稳定 marker。资源来自实际文件字节；CDN 是网络依赖，不能承诺离线可用。
- 页面运行于受限 iframe，不使用 Node.js、文件系统、任意业务 API、WebSocket、Worker、外部 iframe 或本地存储替代宿主持久化。

## 校验与交付

`validate` 检查结构、版本、页面/schema/Logo、依赖闭包、MIME、规范 Base64、UTF-8、字节与 SHA-256。只有脚本输出 `valid: true` 才声称通过该版本协议校验；它不执行 HTML，不证明业务正确、CDN 可访问或目标工作空间兼容。

有宿主与浏览器时验证主要操作、保存后重开恢复、错误/只读反馈、浅深主题与窄/默认/展开尺寸。普通浏览器缺少宿主桥的 HTML 不代表宿主验证。没有宿主仍完成文件交付，注明只做了协议校验。

若任务提供 OpenWorkgraph Run 的 `snapshot.json`、Output 目录与 `validate_visualize_output`，遵循该 Run 的页面和 manifest 协议；工具校验 `page.json`，不能传 `.owgv`。用户要求文件时额外打包。独立文件创作不伪造 Run、manifest、API 或验证工具。

协议来源与更新方法见格式参考的“协议维护”。
