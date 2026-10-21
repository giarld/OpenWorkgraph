# Visualize 页面与宿主 SDK

## 初始化、保存和能力

HTML 可含内联 CSS/JS。宿主注入 SDK，不导入 SDK npm 包、不手写 postMessage 协议。先等待：

```js
const context = await window.visualizeReady;
const v = window.visualize;
const form = structuredClone(context.form.data);
const view = structuredClone(context.state.data);
// context.inputs 是 {version,digest,inputs:[...]}，不是数组。
// context.capabilities: readOnly, online, canCreateSuccessors, canExportAssets?
```

从保存值初始化控件，不在加载时用默认值覆盖保存值。写前根据 capabilities 禁用相关操作并显示直接原因；只读仍可做不写宿主的本地计算。对于冲突、离线、权限或资源错误，保留用户当前输入，显示实际错误，不自动重新初始化或盲重试覆盖其他写者。

| 方法 | 含义 |
| --- | --- |
| `initialize()` | 读取当前会话 context |
| `updateForm(fullObject)` | 全量替换业务表单，返回确认 form 与 revisions |
| `saveState(fullJson)` | 全量替换视图状态，返回确认 state 与 revisions |
| `readInputs(false)` | 读取已接受输入与 inputsChanged/inputError，不接受新值 |
| `readInputs(true)` | 明确接受最新输入，不覆盖 form/state |
| `requestLayout({width,height})` | 请求宿主尺寸，不改变业务值 |
| `createSuccessors(successors, optionalFullForm)` | 创建后继，不执行 |
| `exportAsset({name,mime?,blob})` | 将真实 Blob 导出为工作图资源和后继节点 |

只将下游实际需要的数据放 form；展开项、缩放、选中标签等放 state。表单更新允许缺 required 值但校验字段类型；下游执行再检查 required。SDK 参数和返回数据不是任意宿主 API。

高频输入在本地即时渲染；保存采用一个在途请求加一个最新待保存快照，不堆积 Promise 链。只有确认写入后更新“已保存值”缓存；失败保留本地数据并允许明确重试。成功时只清除对应操作的错误。依赖数据的信号须在所需快照保存成功后发出。

## 输入跟随和媒体

一个输入有 name/edgeId/sourceNodeId、可选 sourceNodeTitle、resources、projectFiles/projectFileData；上游 Visualize 业务数据在 `input.form.data`。资源文本可能在 `resource.text`，项目文件小文本在 `projectFileData[].text`；二进制用 asset 引用，不依赖 base64 字段。不能把读取失败当成空输入。

```js
function showError(error) { /* 在受影响区域显示 error.code/message/fields */ }
function renderInputs(snapshot) { /* snapshot.inputs，重新选择/解码媒体 */ }
renderInputs(context.inputs);
v.signals.on('inputs.updated', event => renderInputs(event.payload.inputs));
await v.signals.connect({
  id: 'follow-inputs',
  source: {nodeId: 'self', signal: 'inputs.invalidated'},
  target: {nodeId: 'self', slot: 'inputs.refresh'}
});
const fresh = await v.readInputs(true); // 连接后一次同步，消除初始化窗口。
if (fresh.inputError) showError(fresh.inputError);
else renderInputs(fresh.inputs);
```

不要同时轮询和信号刷新同一输入。输入更新事件前宿主已准备资产，但页面仍须重新 resolve marker、解码媒体并更新预览；`visualizeAssetsReady` 仅表示初始加载。URL 为 null 或解码失败时禁用依赖该媒体的导出，不能将旧预览标为刷新成功。重新连接输入不应清空用户表单。

固定资源 marker 为 `visualize-resource:<encodedId>@<version>`，项目输入为 `visualize-project-file:<encodeURIComponent(relativePath)>`。在初次媒体使用前等待 `window.visualizeAssetsReady`，JS 调用 `window.visualizeResolveUrl(marker)`。不要保存宿主绝对路径、鉴权 URL、临时预览链接或 Blob URL。

## 摄像头与麦克风（节点浏览器宿主）

工作图节点、展开查看与独立页面提供 `window.visualizeMedia`，通过宿主采集和浏览器内 WebRTC 向隔离页面提供真实 `MediaStream`；不配置外部信令/STUN/TURN。桌面 Chrome/Edge 为首期验证范围，仍需浏览器授权和 HTTPS/localhost。生成测试页和资产预览未开放媒体通道，须先检测接口。

```js
// 在用户点击“开始”等明确操作中调用；根据业务仅申请所需种类。
if (!window.visualizeMedia) throw new Error('请在工作图节点中使用摄像头或麦克风');
const stream = await window.visualizeMedia.getUserMedia({video: true, audio: true});
video.muted = true;
video.playsInline = true;
video.srcObject = stream;
await video.play();
stream.getAudioTracks().forEach(track => { track.enabled = false; }); // 静音
// 使用完毕：stream.getTracks().forEach(track => track.stop());
// 或 window.visualizeMedia.stopAll()，同时停止此页面所有采集。
```

宿主会尽可能兼容 `navigator.mediaDevices.getUserMedia`，专用接口始终优先。支持初始 audio/video 约束、真实音视频预览/分析、`enabled` 静音、`stop()`、轨道/流克隆；最后一个消费者停止才释放对应设备。监听轨道 `ended`：节点离屏/收起、标签页隐藏、刷新/查看切换、权限撤销或连接失败会停止采集，恢复后由用户重新申请。只读/离线不等同于禁止本地设备；摄像头/麦克风开关与浏览器授权继续决定访问。

这不是完整原生设备 API 代理：未开放设备枚举、`getDisplayMedia`，接收轨道的 `applyConstraints()` / `getSettings()` 不代表能调整或获知宿主摄像头硬件。禁止修改 sandbox 或手写宿主消息协议绕过通道。

### 纯音频录制

录音只申请 `{audio:true,video:false}`。当前宿主媒体客户端会在返回流前启动内部静音播放，驱动 Chromium 的 WebRTC 接收音频解码；页面可直接使用 MediaRecorder 或 WebAudio，无须额外创建隐藏播放器，也不会因此外放麦克风声音。旧宿主可能缺少此兼容处理；先更新宿主，不能仅凭接口存在或轨道 live 判断已收到音频样本。

以下为录音的开始/停止辅助函数；在用户操作中调用 `beginRecording()`，将 `stop()` 绑定到用户的停止操作。`showError` 为页面自己的错误呈现函数。

```js
async function beginRecording() {
  if (!window.visualizeMedia || !window.MediaRecorder) throw new Error('当前视图不支持麦克风录音');
  const stream = await window.visualizeMedia.getUserMedia({audio: true, video: false});
  try {
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(value => MediaRecorder.isTypeSupported(value));
    const recorder = mime ? new MediaRecorder(stream, {mimeType: mime}) : new MediaRecorder(stream);
    const chunks = []; let recordingError;
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = event => { recordingError = event.error || new Error('录音失败'); showError(recordingError); };
    const stopped = new Promise(resolve => recorder.addEventListener('stop', () => {
      stream.getTracks().forEach(track => track.stop()); resolve();
    }, {once: true}));
    recorder.start(250);
    return {recorder, async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped; // 最后的 dataavailable 先于 stop；此时才能组装完整文件。
      if (recordingError) throw recordingError;
      const blob = new Blob(chunks, {type: recorder.mimeType});
      if (!blob.size) throw new Error('录音未产生音频数据，请重新开始录音');
      return blob;
    }};
  } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
}
```

录音错误、轨道结束及页面卸载都须有清理路径；暂停/继续可调用 recorder.pause()/resume()，按需要同步轨道 enabled 静音。不要在正常停止时提前销毁轨道或编码上下文；等最终数据收齐再清理。上例返回浏览器支持的录音格式，不能直接改扩展名当作 MP3；需要 MP3 时，对真实录音字节解码并用已加载的 MP3 编码器编码，再经 `exportAsset` 导出 `audio/mpeg` Blob。保留实际采集、录制、解码或编码错误；零字节本身不能证明权限拒绝或设备故障。

有节点宿主测试条件时，纯音频须独立验证：收到非空分段、最终文件可解码且时长大于零、已知测试音产生非零样本，以及暂停/继续、克隆消费者和停止后设备释放。摄像头预览、计时器变化、live 轨道、协议校验或空控制台均不能代替录音验证。生成测试页没有媒体通道，不能据此声称真实录音通过；没有实际验证时明确说明范围。

## 信号、后继与执行

`signals.on(name, handler)` 监听自身并返回取消订阅函数，也支持 `on({nodeId:'predecessors',signal:'outputs.changed'},handler)`。`signals.describe()` 返回真实相邻节点 ID 和类型；不要猜 ID。

`signals.connect({id,source:{nodeId,signal},target:{nodeId,slot},params?})` 是按 id 幂等的连接，`disconnect(id)` 移除。来源支持 self/predecessors/successors 或实际相邻 ID，目标支持 self/successors 或实际普通后继 ID。可观察 inputs.updated/invalidated、form.changed、outputs.changed、content.changed、run.started/succeeded/failed/cancelled 等系统信号；只能 emit 自定义 `custom.*`，不能伪造系统事件。

`signals.defineSlot('custom.render', async params => {...})` 注册页面会话槽，返回异步注销函数。payload 是 JSON，不能带函数或二进制。页面关闭后不提供后台执行或事件回放。

后继形状：

```js
await v.createSuccessors([{type:'text',title:'结果',text:'实际计算结果'}], fullBusinessForm);
// 图片/执行后继是提示词节点；不是把预览像素导出。
const successor = {type:'execution',title:'处理结果',prompt:{
  text:'用户要求的任务',skillReferences:[],features:[],files:[]
}};
```

已有合法技能引用才携带身份和准确的 $name spans；files 为 `{relativePath}`，不伪造宿主路径或权限。执行是单独操作：先通过 describe 取得后继，连接 `custom.execute` 到其 `run.submit`，等待必要的 `updateForm` 成功，再 emit。监听该连接的 `invocation.completed/failed`；emit 的确认不等于槽成功，completed 中 result 的 runId/status 只说明提交被接受，任务完成看 run.*。`run.cancel` 需要该后继准确 runId。

`prompt.update` 槽只保存执行后继提示词，payload 为 `{prompt,expectedContentVersion?}`，不改变模型也不执行；须等 invocation.completed 后另行提交运行，不能把两个槽绑定同一信号当作顺序事务。内容更新槽同样仅保存，按目标节点类型和当前宿主支持使用，不猜字段。

除用户明确要求自动流程，不在初始化、输入刷新、表单保存时执行后继。执行仍使用目标配置与原生权限。

## 真实文件导出

```js
if (!context.capabilities.canExportAssets) throw new Error('当前工作空间不支持资源导出');
const blob = await new Promise((resolve, reject) => canvas.toBlob(
  value => value ? resolve(value) : reject(new Error('图片编码失败')), 'image/png'
));
const result = await v.exportAsset({name:'result.png',mime:'image/png',blob});
// 确认后才报告成功；返回资源/节点/边身份与修订。
```

仅明确用户动作导出，不随滑块变化自动导出。不要传 nodeType/target/path/base64；宿主决定工作图资源和后继节点，不创建资产库条目、不启动 Run 或浏览器下载。文本结果仍用 text 后继，任务仍用 execution 后继。

## 样式与测试

默认尺寸 480×360；生成 layout 不超过 1440×1080。iframe 内容尺寸比节点含宿主栏的外尺寸小；按内容宽度响应，保留一个文档纵向滚动区。可用 tokens：`--canvas/--panel/--fill/--text/--muted/--stroke/--active/--danger`。

基础类：`visualize-page/stack/grid/card/field/help/actions/primary/secondary/notice/error/badge`（各带 visualize- 前缀）。操作面板可用 visualize-tool-panel/tool-display/keypad；直接操作用 visualize-direct/tool-bar/surface；双编辑器用 visualize-editors/editor/editor-bar。它们提供布局与默认外观，不提供业务处理器。使用正确 label、原生 disabled、可见焦点、可操作错误，避免惯性给所有工具套输入/结果/提交表单。

默认不覆盖根 tokens 和控件配色；`--active` 在深色可能近白，不能搭固定白字。明确要求自定义风格时成对设置前景/背景并验证各状态。不在页面附加 Agent/模型/权限摘要或常驻保存标签。

真实宿主验证主要交互、保存恢复、错误/只读、浅深主题与窄尺寸。Run 的临时 preview 工具若可用则遵循其说明：测试写入为临时数据，后继不会真实执行，信号及执行/提示词/内容槽不可用。协议校验或空控制台不能替代业务验证。
