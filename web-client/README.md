# OpenWorkgraph Web Client

独立 React / TypeScript / Vite 前端。产品仅有一套工作图编辑器：工作图均由已连接的工作空间保存与管理。左上角主菜单进入“我的工作图”（#workgraphs），在独立列表页选择工作空间、项目及工作中/已归档/回收站范围，进行新建、导入、导出、重命名、删除与恢复。批量删除移入回收站。编辑器左侧仅显示节点预览与资产库；工作空间管理保留在右侧面板。旧开发样例已移入测试夹具，不再通过产品 URL 或菜单提供另一套界面。

工作空间配对、连接列表和工作空间管理位于可收起的右侧边栏。

未关联工作空间时显示快速开始入口，引导安装、启动并配对工作空间。默认使用 `npm install -g openworkgraph` 和 `openworkgraph start`，折叠选项保留 npx 启动方式。浏览器临时工作区已移除；旧的浏览器选择和最近记录不再打开，已有 IndexedDB 数据不会自动删除。工作空间断线后，已有工作图仍按原规则只读。

工作图可通过“复制到项目工作区”复制到已连接工作空间中的启用项目；响应丢失时重试沿用原快照和幂等键，避免重复创建。复制不会启动 AI。

用户导出的工作图文件为 `.workgraph.zip`。ZIP 根目录的 `workgraph.json` 保存工作图结构和资源元数据，`assets/` 保存资源原始字节；结构 JSON 不内嵌 Base64。导入仅接受该 ZIP 格式，解包后继续使用统一图包校验与原子导入流程。

导入时在目标项目全部工作图（包括归档和回收站）中检查同名。名称未占用时保持原名；冲突时依次使用 `原名 (1)`、`原名 (2)`，直到找到首个可用名称。

启动 Web 开发服务时，在仓库根目录执行：

```sh
npm --prefix web-client ci --include=dev
npm run dev:web
```

`dev:web` 等同于 `npm --prefix web-client run dev`。访问地址以终端输出为准，按 Ctrl+C 关闭。需要本地工作空间时，在另一个终端的仓库根目录执行 `npm ci --include=dev` 和 `npm run dev:service`；后者每次重新构建后以前台方式启动，也可按 Ctrl+C 关闭。

仅构建 Web 时，在仓库根目录执行：

```sh
npm --prefix web-client ci --include=dev
npm run build:web
```

Web 使用独立依赖和锁文件，根目录的 `npm ci` 不会安装本目录的依赖；`--include=dev` 确保安装 Vite、TypeScript 等构建工具。生产构建无需协议或工作空间编译产物。

完整 Web 类型检查和集成测试引用协议与工作空间编译产物，须先从仓库根目录运行 `npm ci --include=dev` 和 `npm run build`，再在本目录运行：

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run test:e2e
npm run build
```

源码位于 `src/`，测试位于 `tests/`，生产构建输出到 `dist/`。浏览器测试使用 Chrome，自动启动开发运行时器，验收截图与性能数据写入 `../docs/validation/`。

参见[开发与接口交接](../docs/development/phase-1-web.md)、[项目说明与来源许可](../README.md)。
