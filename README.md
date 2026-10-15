# OpenWorkgraph

> [!IMPORTANT]
> OpenWorkgraph 是基于无限画布思想的全能可视化智能体工作台产品，除了图、文、视频生成、软件开发等工作，还能组织各种用途的 Agent 工作流。
>
> 可视化智能体工作台
> Visual Agent Workbench
> AI 是创造万象的魔法，Workgraph 是执掌魔法的魔杖。

简体中文 | [English](README.en.md)

## 快速开始

打开 [OpenWorkgraph 官方编辑器](https://canvas.giarld.com)，按照页面提供的引导完成配置即可开始使用。

## 设计哲学：第一性原理

![输入经由系统转化为输出](assets/readme/first-principles.png)

## 本地构建与运行

### Agent Service

在仓库根目录构建协议包和 Agent Service：

```sh
npm ci --include=dev
npm run build
```

构建完成后，以前台方式运行 Agent Service：

```sh
node agent-service/dist/cli.js start
```

### Web Client

在仓库根目录构建 Web Client，并通过 Vite Preview 在 `http://127.0.0.1:4173` 运行生产构建：

```sh
npm --prefix web-client ci --include=dev
npm run build:web
npm --prefix web-client run preview -- --host 127.0.0.1 --port 4173
```

Web Client 使用独立的依赖和锁文件，根目录的 `npm ci` 不会安装 Web 依赖。首次构建须执行上述 Web 安装命令；`--include=dev` 确保安装 TypeScript、Vite 等构建工具。仅构建 Web 无需先运行 Agent Service 构建。

打开 Web Client 后，填写运行时地址并点击“生成客户端码”。在运行时所在机器执行以下命令，输入浏览器显示的 8 位客户端码，核对来源和公钥指纹后确认；浏览器会轮询批准状态，完成私钥证明和通讯凭据交换后自动连接：

```sh
node agent-service/dist/cli.js pair --client-code '<客户端码>'
```

客户端码显示为连续 8 位数字，例如 `12345678`，中间没有空格，5 分钟有效。终端默认输出英文可读的批准结果；仅脚本需要解析时加 `--output-json`（非交互批准还需 `--yes`）。

一机只运行一个服务。`--data-dir` 仅用于 `start` 和 `serve`；启动成功后自动记住目录，配对、查看状态、停止、日志和备份命令都无需再填写。停服后运行 `start` 会沿用原目录，首次启动未指定时使用用户主目录下的 `.openworkgraph`。重复启动会明确拒绝，不提供服务选择或切换步骤。

无需手填 `--origin`，不强制 HTTPS，支持可信局域网普通 HTTP。HTTP 不加密，请勿暴露公网。

### 检查与测试

```sh
npm test
npm --prefix web-client run typecheck
npm --prefix web-client test
npm --prefix web-client run build
npm --prefix web-client run test:e2e
```

以上命令在仓库根目录执行；Web 构建输出为 `web-client/dist/`，浏览器测试使用已安装的 Chrome。

## 参考依据与致谢

Web UI 参考了 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 的视觉风格和画布交互，感谢原作者 basketikun。该项目采用 [MIT License](https://github.com/basketikun/infinite-canvas/blob/d213a74614e0e4bd8a26383d1e1e907249e9c61b/LICENSE)；复用其代码或其他适用内容时，应保留原版权与许可声明。第三方素材若有独立授权，以其各自许可为准。

## 许可证

本项目采用 [MIT License](LICENSE)。第三方来源的版权与许可声明按原始归属保留。

## 阶段 3 当前实现与限制（2026-10-13）

默认生产组合注册 Codex 和 Claude Code 正式插件。Claude CLI 需在工作空间机器独立安装和认证，不随 npm 包分发。Claude 插件支持执行、文本与 visualize 生成，文件/图片及经原生工具处理的视频输入、命令与联网、后台任务、审批/提问、技能与配置、动态技能命令和会话恢复。完全访问自动审批，提问仍需用户答复。原生生图及 OS 沙盒不在支持范围；视频/Office 解码依赖设备工具，Linux/Windows 的支持声明不代表已完成设备验收。实现和验证边界见 [Claude 插件能力](docs/development/claude-plugin-capabilities.md)。

dynamic 模型目录来自原生 stream-json control initialize，不发 user 消息。保留模型/effort 顺序，别名不表示版本锁。完整插件要求 CLI 2.1.296 起；2026-10-14 真实 macOS 问答、页面和技能命令已通过，版本/目录诊断仍不等于所有模型与平台健康。设备凭据、executable、env 不进入 Web options 或冻结快照；managed hooks 与完整设备矩阵单列验收。

新版配置独立存储于 config/agent-configuration.sqlite，generation 为 agent-configuration-v1，不读取或迁移旧设置。GET/POST /v1/agents/configuration 以 section CAS 分别管理公共 permissions、各 backend、default 与 order；旧 API、缺省 agent 的旧请求和图片路由保留原语义。新版提交显式携带 generation、backend configRevision 和 permissions（revision/project/runs），接受时复核并冻结，后续全局设置不改写已接受任务。

公共 project 可保存 read-only/workspace-write/danger-full-access，runs 固定 read-write；保存不等于所有插件都支持。当前 Codex 原生 readOnly 禁 runs 写入，workspaceWrite 又将项目 cwd 纳入可写，不能实现项目只读+runs 可写，明确拒绝新版 read-only 提交（capability_unsupported）。含 Codex 的工作空间仍能保存公共 read-only，UI 可提示该限制；Codex workspace-write/full 可用，历史权限语义保留。Claude 使用 //absolute/path 的 Edit scoped allow/deny（Edit 同时控制 Write）；workspace-write 通过原生权限机制及 Web 审批，danger-full-access 自动批准权限请求，read-only 禁止项目修改和命令/Agent 工具。Claude 不提供 OS 命令沙盒。宿主保留项目身份、资源完整性及输出路径业务校验，不新增自定义权限执行器。

restoredRunStart 是恢复备份冻结任务后重新预检并启动，不是 --resume、续聊或重新附着；无原 responder 时不能伪造协调成功。结果未知保留占用，不切换插件或自动重启原 attempt。插件 completed 仍须经宿主 Publication 校验才能交付。原生证据见 [阶段 3 原生验证](docs/validation/agent-plugin-phase-3.md)，工程包证据见 [阶段 3 打包验证](docs/validation/agent-plugin-phase-3-packaging.md)。
