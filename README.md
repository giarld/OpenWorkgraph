# OpenWorkgraph

OpenWorkgraph 是基于无限画布思想的软件开发工作流产品，同时面向其他领域的工作组织与协作。

简体中文 | [English](README.en.md)

## 快速开始

打开 [OpenWorkgraph 官方编辑器](https://workgraph.giarld.com/)，按照页面提供的引导完成配置即可开始使用。

## 设计哲学：第一性原理

![输入经由系统转化为输出](assets/readme/first-principles.png)

## 本地构建与运行

### Agent Service

在仓库根目录构建协议包和 Agent Service：

```sh
npm run build
```

构建完成后，以前台方式运行 Agent Service：

```sh
node agent-service/dist/cli.js start
```

### Web Client

在仓库根目录构建 Web Client，并通过 Vite Preview 在 `http://127.0.0.1:4173` 运行生产构建：

```sh
npm --prefix web-client run build
npm --prefix web-client run preview -- --host 127.0.0.1 --port 4173
```

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
