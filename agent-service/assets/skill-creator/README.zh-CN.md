# OpenWorkgraph 技能创建器

[English](README.md)

创建或更新 OpenWorkgraph 技能，也可将遵循 OpenAI 和 agents/skills 标准的通用技能转换为 OpenWorkgraph 技能包。

## 功能

- 编写聚焦任务的 Agent 指令，按需添加资源。
- 补充英文回退 README、多语言 README 和结构化 `config.json` 配置声明。
- 转换时保留原有工作流、资源、许可证、元数据和调用策略。
- 识别环境变量需求并验证仓库打包约定。

## 使用方法

在支持 `SKILL.md` 的 Agent 中调用，说明任务或源目录及目标位置：

```text
使用 $openworkgraph-skill-creator 创建一个汇总本地 CSV 文件的技能，
保存到 skills/csv-summary，并提供英文和简体中文 README。
```

```text
使用 $openworkgraph-skill-creator 将 ./existing-skill 转换为
OpenWorkgraph 技能，保存到 ./skills/existing-skill，保留原有工作流。
```

官方仓库采用 `skills/<skill-name>/` 目录布局。转换默认输出到独立目标目录；如需原地转换，请明确说明。

## 依赖与配置

Agent 需要访问源目录和目标目录的文件权限。本创建器无需 API Key、环境变量、网络访问或另行安装的 skill-creator。内置配置校验脚本只需 Python 3，无第三方依赖；上游 frontmatter 验证工具为可选工具。

本技能的 `config.json` 声明版本 `1` 和空 `environment` 数组。所有配置声明统一使用 `config.json`。环境变量字段、多语言显示和敏感输入约定见[配置格式](references/configuration.md)。

由于尚未提供现有产品配置规范，这套格式是本仓库新定义的约定。OpenWorkgraph 应用端仍需接入解析和环境变量注入；仓库校验通过不代表应用兼容性已验证。

## 产物与验证

技能目录包含 `SKILL.md`、英文 `README.md`、`config.json`、所需语言的 README 和必要资源。在官方仓库新建技能时同时提供 `README.zh-CN.md`。发布与安装需要另行提出请求。

在本创建器目录下验证目标技能配置：

```bash
python3 scripts/validate_config.py /path/to/target-skill/config.json
```

完成报告说明文件变更、验证结果和未解决的集成条件。Agent 指令见 [SKILL.md](SKILL.md)，验证清单见[打包参考](references/packaging.md)。
