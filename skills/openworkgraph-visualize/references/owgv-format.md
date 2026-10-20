# .owgv 格式与编写源

## 版本和结构

文件 `openworkgraph.visualize-asset/1`、页面 `openworkgraph.visualize-page/2`、桥 `1`、表单 dialect `openworkgraph.visualize-form/1` 相互独立，也独立于产品 SemVer。MIME 为 `application/vnd.openworkgraph.visualize+json`。新文件用 `.owgv`；脚本也读取旧 `.owvisualize.json`，空白节点上传入口仅接受 `.owgv`。

顶层必须且仅有 `format/version/title/node/inputNames/resources`，node 必须且仅有 `title/width/height/content`。结构示意如下，资源字段由脚本计算：

```text
{
  format: "openworkgraph.visualize-asset", version: 1, title: "工具名称",
  node: { title: "工具名称", width: 480, height: 360, content: {
    title: "工具名称", prompt: "功能描述", inputBindings: [],
    page: { revision: 1, resource: {resourceId:"r1",resourceVersion:1}, dependencies: [] },
    form: { pageRevision:1, schemaVersion:1, version:1, data:{},
      resource:{resourceId:"r2",resourceVersion:1} },
    state: { pageRevision:1, version:1, data:{} }
  } },
  inputNames: [], resources: [页面 JSON 资源, 表单 JSON 资源, 依赖资源...]
}
```

- 页面与表单身份不同，MIME 均为 application/json，内容为 UTF-8 JSON。
- 资源字段恰为 `resourceId/version/name/mime/bytes/sha256/base64`，ID 唯一且匹配 `[A-Za-z][A-Za-z0-9._-]*`，version 为 1；引用形状为 `{resourceId,resourceVersion}`。
- page/form/state 实例修订均为 1；`content.form.schemaVersion` 等于 `page.form.version`，后者是独立的正整数业务 schema 版本。
- `content.form.data` 与表单资源 JSON 相同；默认模板用 `initialForm/initialState`，旧包可含不同当前快照。
- `content.page.dependencies` 为页面资源依赖及 schema/initialForm/initialState tagged refs 的去重闭包，不包含页面/表单资源。仅当前 form/state 使用的资源须携带，但不加到此数组。
- `page.inputNames` 若有须等于顶层 inputNames，名称唯一非空，最多 64 个、每个 128 字符；不会接线或授予访问权限。
- 安装时分配新身份，不能依赖 r1 等局部 ID 在目标工作图中保持不变。

## source.json 编写源

脚本接受下列结构，完整可用示例见 `assets/source.json`：

```json
{
  "title": "图片查看器",
  "prompt": "展示参考图片",
  "htmlFile": "tool.html",
  "page": {
    "format": "openworkgraph.visualize-page", "version": 2, "bridgeVersion": 1,
    "logoSvg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect x=\"12\" y=\"16\" width=\"40\" height=\"32\" rx=\"6\" fill=\"#3478B8\"/><circle cx=\"42\" cy=\"26\" r=\"5\" fill=\"#E98273\"/></svg>",
    "dependencies": [{"kind":"resource","id":"photo","media":"image","resourceId":"photo","resourceVersion":1}],
    "form": {"dialect":"openworkgraph.visualize-form/1","version":1,"schema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},
    "initialForm": {}, "initialState": {},
    "layout": {"width":480,"height":360}, "inputNames": []
  },
  "assets": [{"resourceId":"photo","path":"media/photo.png","mime":"image/png"}]
}
```

路径相对于 source JSON 的目录。`htmlFile` 与 `page.html` 二选一。可选 assets 每项必需 `resourceId/path/mime`、可选显示名 name。只读取显式文件，不扫描目录或下载 CDN。resourceId 为本地别名，不冒充工作图身份；`__owgv_page/__owgv_form` 为脚本保留别名。无闭包引用的 assets 不入包。

可选 `snapshot:{form,state,width,height}` 保留解包的既有数据和尺寸，新建通常省略。源文件仅接受 `title/prompt/htmlFile/page/assets/snapshot`。脚本重映射声明、HTML 固定 marker 和 JSON tagged refs，不重写 JS 任意拼接的身份字符串。动态身份应来自 SDK 当前输入或重映射后的 form/state。

## 页面、schema 和资源

页面必需 `format/version/bridgeVersion/html/dependencies/form/initialForm/initialState/logoSvg`，可选 layout/inputNames。不要添加 title/javascript/css/layoutMode 等字段，JS/CSS 放在 HTML。

schema 根为 object。支持 `type/title/description/enum`、`properties/required/additionalProperties`、`items/minItems/maxItems`、`minLength/maxLength`、`minimum/maximum`；类型仅 object/array/string/number/integer/boolean/null。不支持 $ref/default/pattern、联合类型、格式扩展或可执行验证。默认值放 initialForm；保存允许缺 required 值，但类型等约束仍校验，下游执行才查 required。

资源依赖与业务引用不可混用：

```json
{"kind":"resource","id":"photo","media":"image","resourceId":"photo","resourceVersion":1}
```

```json
{"format":"openworkgraph.asset-reference","version":1,"kind":"resource","resourceId":"photo","resourceVersion":1}
```

第一种用于 page.dependencies，第二种用于 schema enum、form/state（须匹配 schema）。普通字符串不作为资产处理。HTML 固定引用为 `visualize-resource:photo@1`，一般形式 `visualize-resource:<encodeURIComponent(resourceId)>@<resourceVersion>`；JS 使用 `window.visualizeResolveUrl(marker)`，null 表示不可用，不保存返回的 Blob URL。

media 仅 script/style/image/video，对应 JS/CSS/image/*/video/*；video 也允许 audio/*。CDN 为 `{kind:"cdn",id,media,url,version,integrity?}`，HTTPS、固定版本字符串，无凭据和 fragment，integrity 如有为 SRI；不入 resources，仍需网络。

包不保留 project-file live 或 output 引用。固定项目文件时将实际字节列入 assets，改写声明/marker/tagged refs 为 resource。运行时从 SDK 输入取得 live 引用不受此限制。

Logo 为内联 SVG：xmlns 为 http://www.w3.org/2000/svg，viewBox 为 0 0 64 64。透明背景、显式十六进制颜色；优先 2–6 个实心几何图形，生成目标最多 10 个 / 2 KiB，四周约 8 单位安全区。可选配色 `#287568/#D99A35`、`#3478B8/#E98273`、`#5276A5/#38B6A0`，一次选一组固定使用。不调用生图模型；禁止脚本、CSS、事件、外部引用、位图、实体、渐变、动画和 currentColor。兼容硬上限 64 个图形元素 / 8 KiB；脚本对新源严格校验，不依赖发布 Logo 回退。

## 预算和兼容

| 内容 | 上限 |
| --- | --- |
| 文件 JSON | 32 MiB |
| 解码资源总量 | 24 MiB |
| 资源数（含页面与表单） | 256 |
| 页面 JSON | 4 MiB |
| HTML | 2,097,152 个 JS 字符单元 |
| 表单或状态 JSON | 各 1 MiB |
| page.dependencies / snapshot dependencies | 各 64 |
| 单次业务 tagged refs 扫描 | 64 个去重引用 |

媒体字节只在外层资源 base64 中编码。若有目标工作空间连接，读取 `GET /v1/info` 的 `visualizeCompatibility.minimumVersion/currentVersion` 检查版本，沿用现有认证。未验证目标版本时仅报告本地结果。

## 协议维护

真值源为开发仓库 `packages/protocol/src/visualize-library.ts`、`visualize-validation.ts`、`visualize.ts`、`visualize-assets.ts`、`visualize-logo.ts`；运行参考 `agent-service/src/prompts/visualize.ts` 与 `web-client/src/real/visualize-html.ts`。随技能的 `scripts/vendor/protocol.mjs` 从协议源码生成，保留 MIT 许可证，头部记录产品版本及源码摘要。日常运行无需仓库或 esbuild。

维护者在已安装依赖的开发仓库更新后执行：

```text
node "<SKILL_DIR>/scripts/update-protocol.mjs" "<OpenWorkgraph 开发仓库绝对路径>"
```

维护命令解析指定仓库的 esbuild，更新 bundle 与许可证；不要手改生成代码。协议变化时同步参考和样例，并验证新建、解包再打包和损坏文件拒绝；产品升版不等于文件协议升版。
