import type { GraphOperation, GraphSnapshot } from './contracts';
import { randomId } from '../adapter/random';
import { nodeBounds } from './graph-layout';
import { outputPlacement } from './output-placement';

export type SkillAuthoringMode = 'create' | 'convert';
type Point = { x: number; y: number };
export const SKILL_AUTHORING_SIZE = { width: 892, height: 608 };

export function skillAuthoringGroup(graph: GraphSnapshot, mode: SkillAuthoringMode, chinese: boolean, anchor: Point, visible?: Point & { width: number; height: number }): { operations: GraphOperation[]; groupId: string; inputId: string } {
  const copy = (en: string, zh: string) => chinese ? zh : en;
  // Treat entire existing group frames as obstacles; never adopt the new group.
  const position = outputPlacement(graph.nodes.map(node => ({ ...node, ...nodeBounds(node), type: 'text' })), { ...anchor, ...SKILL_AUTHORING_SIZE }, anchor, visible);
  const groupId = randomId(), inputId = randomId(), executionId = randomId(), documentId = randomId();
  const title = mode === 'convert' ? copy('Convert existing skill', '转换现有技能') : copy('Create new skill', '创建新技能');
  const prompt = mode === 'convert'
    ? copy('Convert the skill identified by the upstream text node into an OpenWorkgraph skill and install it in the current Workspace. The input may be a skill directory, SKILL.md path, public Git repository, or a repository skill link. Local paths refer to the Workspace host. Inspect the source, scripts, resources and license; preserve behavior and attribution. If a repository contains multiple skills and no target was specified, ask which one to convert. Use the built-in OpenWorkgraph Skill Creator, validate the complete package, then install with install_generated_skill. Report the installed skill and any remaining prerequisites.', '将上游文本节点指定的技能转换为 OpenWorkgraph 技能并安装到当前工作空间。输入可以是技能目录、SKILL.md 文件路径、公开 Git 仓库或仓库内技能链接；本地路径位于工作空间主机。先检查原技能、脚本、资源和许可证，保留行为与署名。仓库包含多个技能且未指定目标时，先询问用户。使用内置 OpenWorkgraph 技能创建器，校验完整技能包后调用 install_generated_skill 安装，并报告安装结果和仍需准备的依赖。')
    : copy('Create an OpenWorkgraph skill from the requirements in the upstream text node and install it in the current Workspace. Use the built-in OpenWorkgraph Skill Creator. Infer inputs, outputs and dependencies from the requirements; ask only about missing information that affects the result. Create useful instructions, human-facing READMEs and configuration declarations, validate the complete package, then install with install_generated_skill. Report the installed skill and any remaining prerequisites.', '根据上游文本节点的需求创建 OpenWorkgraph 技能并安装到当前工作空间。使用内置 OpenWorkgraph 技能创建器，从需求推导输入、输出和依赖，仅询问影响结果的缺失信息。编写技能指引、面向用户的说明与配置声明，校验完整技能包后调用 install_generated_skill 安装，并报告安装结果和仍需准备的依赖。');
  const usage = mode === 'convert'
    ? copy('## Convert an existing skill\n\n1. Enter a skill directory, SKILL.md path, public Git repository URL, or a repository skill link in the text node above. Paths refer to the Workspace host, not this browser’s computer.\n2. Run the execution node on the right. A repository with multiple skills may require choosing one.\n3. Answer questions or approvals through the existing run controls. The built-in creator validates and installs the package.\n4. Refresh the skill library and open Installed. Configure any required variables before use.\n\nThe creator requires no prior installation. Creating this group does not start a run. Skills already installed from other sources are preserved.', '## 转换现有技能\n\n1. 在上方文本节点填写技能目录、SKILL.md 路径、公开 Git 仓库链接或仓库内技能链接。本地路径指工作空间主机上的路径，不是浏览器所在设备。\n2. 手动运行右侧执行节点；仓库包含多个技能时，按提示选择目标。\n3. 通过现有运行交互回答问题或处理审批，内置创建器会校验并安装技能包。\n4. 刷新技能库，在“已安装”中查看；使用前按需配置必填变量。\n\n无需预先安装技能创建器。增加节点组不会自动运行。其他来源的已安装技能会保留。')
    : copy('## Create a new skill\n\n1. Describe the skill’s purpose, inputs, expected outputs and dependencies in the text node above.\n2. Run the execution node on the right, then answer any questions or approvals through the existing run controls.\n3. The built-in creator generates, validates and installs the package in this Workspace.\n4. Refresh the skill library and open Installed. Configure any required variables before use.\n\nThe creator requires no prior installation. Creating this group does not start a run. Skills already installed from other sources are preserved.', '## 创建新技能\n\n1. 在上方文本节点描述技能用途、输入、预期输出及依赖。\n2. 手动运行右侧执行节点，通过现有运行交互回答问题或处理审批。\n3. 内置创建器会生成、校验技能包并安装到当前工作空间。\n4. 刷新技能库，在“已安装”中查看；使用前按需配置必填变量。\n\n无需预先安装技能创建器。增加节点组不会自动运行。其他来源的已安装技能会保留。');
  const node = (id: string, type: string, content: Record<string, string>, x: number, y: number, width: number, height: number) => ({ id, type, schemaVersion: 1, contentVersion: 1, content, x: position.x + x, y: position.y + y, width, height, readOnly: false });
  return { groupId, inputId, operations: [
    { type: 'node.create', node: node(inputId, 'text', { title: mode === 'convert' ? copy('Skill URL or file path', '技能URL或文件路径') : copy('Skill requirements', '技能需求'), text: '', prompt: '' }, 24, 48, 360, 180) },
    { type: 'node.create', node: node(executionId, 'execution', { title, prompt, skillAuthoring: mode }, 448, 48, 420, 300) },
    { type: 'node.create', node: node(documentId, 'document', { title: copy('Usage', '用法提示'), text: usage }, 24, 284, 360, 300) },
    { type: 'edge.create', edge: { id: randomId(), sourceId: inputId, targetId: executionId, kind: 'reference' } },
    { type: 'node.create', node: { ...node(groupId, 'group', { title }, 0, 0, SKILL_AUTHORING_SIZE.width, SKILL_AUTHORING_SIZE.height), memberIds: [inputId, executionId, documentId] } },
  ] };
}
