import type { VisualizeInputSnapshot, VisualizeSchemaDeclaration } from '@openworkgraph/protocol';

/** Executable examples injected into generation instructions, shared with regression tests. */
export const visualizeImageInputExample: VisualizeInputSnapshot = {
  version: 1, digest: '0'.repeat(64), inputs: [
    { name: 'photo-resource', edgeId: 'edge-resource', sourceNodeId: 'image-node', contentVersion: 1,
      resources: [{ kind: 'image', sourceNodeIds: ['image-node'], text: null, resource: {
        resourceId: 'provided-graph-resource-id', version: 3, mime: 'image/png', bytes: 123456,
        sha256: 'a'.repeat(64), representationVersion: null,
      } }],
    },
    { name: 'photo-file', edgeId: 'edge-project-file', sourceNodeId: 'file-image-node', contentVersion: 1,
      resources: [], projectFiles: [{ kind: 'image', relativePath: 'images/照片 01.png',
        sourceNodeIds: ['file-image-node'], edgeIds: ['edge-project-file'] }],
      projectFileData: [{ kind: 'image', relativePath: 'images/照片 01.png', mime: 'image/png',
        bytes: 123456, sha256: 'b'.repeat(64), changeToken: 'provided-file-change-token', text: null,
        asset: { format: 'openworkgraph.asset-reference', version: 1, kind: 'project-file',
          relativePath: 'images/照片 01.png', mode: 'live' },
      }],
    },
  ],
};

export const visualizeImageSourceForm: VisualizeSchemaDeclaration = {
  dialect: 'openworkgraph.visualize-form/1', version: 1, schema: {
    type: 'object', properties: { source: {
      type: 'object', properties: {
        format: { type: 'string', enum: ['openworkgraph.asset-reference'] },
        version: { type: 'integer', enum: [1] },
        kind: { type: 'string', enum: ['resource', 'project-file'] },
        resourceId: { type: 'string', minLength: 1 }, resourceVersion: { type: 'integer', minimum: 1 },
        relativePath: { type: 'string', minLength: 1 }, mode: { type: 'string', enum: ['live'] },
      }, required: ['format', 'version', 'kind'], additionalProperties: false,
    } }, required: ['source'], additionalProperties: false,
  },
};

export const visualizeCollectInputImagesExample = String.raw`function imageAssetMarker(asset) {
  if (asset?.kind === 'resource')
    return 'visualize-resource:' + encodeURIComponent(asset.resourceId) + '@' + asset.resourceVersion;
  if (asset?.kind === 'project-file')
    return 'visualize-project-file:' + encodeURIComponent(asset.relativePath);
  return null;
}
function collectInputImages(snapshot) {
  const found = new Map();
  function add(asset, metadata, fingerprint) {
    const marker = imageAssetMarker(asset);
    if (!found.has(marker)) found.set(marker, {
      asset, marker, signature: JSON.stringify([marker, ...fingerprint]), ...metadata
    });
  }
  for (const input of snapshot.inputs) {
    for (const item of input.resources ?? []) {
      const resource = item.resource;
      if (!resource?.mime.startsWith('image/')) continue;
      const asset = { format: 'openworkgraph.asset-reference', version: 1, kind: 'resource',
        resourceId: resource.resourceId, resourceVersion: resource.version };
      add(asset, { label: input.name, mime: resource.mime, bytes: resource.bytes }, [resource.sha256]);
    }
    for (const file of input.projectFileData ?? []) {
      if (!file.mime.startsWith('image/') || file.asset.kind !== 'project-file') continue;
      const { format, version, kind, relativePath, mode } = file.asset;
      const asset = { format, version, kind, relativePath, mode };
      add(asset, { label: input.name + ': ' + file.relativePath, mime: file.mime, bytes: file.bytes },
        [file.changeToken, file.sha256]);
    }
  }
  return [...found.values()];
}`;

/** Minimal complete media page; dependencies are empty because accepted inputs authorize media. */
export const visualizeImageSelectionHtmlExample = `<main class="visualize-page visualize-stack">
  <h1>图片输入</h1>
  <label for="source">选择图片</label><select id="source"></select>
  <img id="photo" alt="所选图片预览" hidden style="max-width:100%">
  <div class="visualize-actions">
    <button id="check" type="button">检查输入</button>
    <button id="refresh" type="button">刷新输入</button>
    <button id="next" type="button" class="visualize-primary" disabled>创建后继任务</button>
  </div>
  <p id="status" role="status"></p><p id="error" role="alert"></p>
</main><script>
${visualizeCollectInputImagesExample}
(async () => {
  const context = await window.visualizeReady;
  await window.visualizeAssetsReady;
  let images = collectInputImages(context.inputs);
  const source = document.getElementById('source');
  const photo = document.getElementById('photo');
  const next = document.getElementById('next');
  const refresh = document.getElementById('refresh');
  const status = document.getElementById('status');
  const error = document.getElementById('error');
  const showError = reason => { error.textContent = [reason.code, reason.message,
    reason.fields ? JSON.stringify(reason.fields) : ''].filter(Boolean).join(': '); };
  let form = { ...context.form.data };
  let busy = false;
  let media = new Map(images.map(image => [image.marker, {
    signature: image.signature, url: window.visualizeResolveUrl(image.marker)
  }]));
  const unavailable = new Set();
  function populate() {
    source.replaceChildren();
    source.add(new Option(images.length ? '请选择图片' : '没有图片输入', ''));
    for (const image of images) source.add(new Option(image.label, image.marker));
    source.disabled = images.length === 0;
  }
  populate();
  status.textContent = images.length ? '请选择一张图片。' : '请在工作图中连接图片，再使用节点顶部的刷新输入。';
  async function selectImage(save) {
    busy = true; source.disabled = true; refresh.disabled = true; next.disabled = true;
    error.textContent = ''; photo.hidden = true; photo.removeAttribute('src');
    try {
      const selected = images.find(image => image.marker === source.value);
      if (!selected) {
        const data = { ...form }; delete data.source;
        if (save) { await window.visualize.updateForm(data); form = data; }
        status.textContent = '请选择一张图片。'; return;
      }
      const url = window.visualizeResolveUrl(selected.marker);
      if (!url || unavailable.has(selected.marker))
        throw new Error('图片尚未加载，请使用节点顶部的刷新输入或重新打开页面。');
      photo.src = url; await photo.decode(); photo.hidden = false;
      if (save) {
        const data = { ...form, source: selected.asset };
        await window.visualize.updateForm(data); form = data;
      }
      status.textContent = '图片已加载，选择已保存。'; next.disabled = false;
    } catch (reason) { photo.hidden = true; showError(reason); }
    finally { busy = false; source.disabled = images.length === 0; refresh.disabled = false; }
  }
  source.onchange = () => { if (!busy) void selectImage(true); };
  const savedMarker = imageAssetMarker(form.source);
  if (images.some(image => image.marker === savedMarker)) {
    source.value = savedMarker; await selectImage(false);
  } else if (form.source) {
    status.textContent = '保存的图片已不在当前输入中，请重新选择。';
  } else if (images.length === 1) {
    source.value = images[0].marker; await selectImage(true);
  }
  document.getElementById('check').onclick = async () => {
    try {
      const result = await window.visualize.readInputs(false);
      if (result.inputError) { showError(result.inputError); return; }
      status.textContent = result.inputsChanged
        ? '输入已变化，请刷新输入重新加载图片。'
        : '当前接受的输入没有变化。';
    } catch (reason) { showError(reason); }
  };
  refresh.onclick = async () => {
    if (busy) return;
    busy = true; refresh.disabled = true; source.disabled = true; next.disabled = true;
    error.textContent = ''; photo.hidden = true; photo.removeAttribute('src');
    const selectedMarker = source.value;
    try {
      const result = await window.visualize.readInputs(true);
      if (result.inputError) throw result.inputError;
      images = collectInputImages(result.inputs); unavailable.clear();
      const updated = new Map();
      for (const image of images) {
        const url = window.visualizeResolveUrl(image.marker), previous = media.get(image.marker);
        if (!url || previous && previous.signature !== image.signature && previous.url === url)
          unavailable.add(image.marker); // Never show stale bytes as a refreshed preview.
        else updated.set(image.marker, { signature: image.signature, url });
      }
      media = new Map([...media, ...updated]);
      populate();
      if (images.some(image => image.marker === selectedMarker)) {
        source.value = selectedMarker; await selectImage(false);
      } else {
        status.textContent = images.length ? '输入已刷新，请重新选择图片。' : '当前没有图片输入。';
      }
    } catch (reason) { showError(reason); }
    finally { busy = false; refresh.disabled = false; source.disabled = images.length === 0; }
  };
  next.onclick = async () => {
    if (busy) return;
    busy = true; source.disabled = true; refresh.disabled = true; next.disabled = true; error.textContent = '';
    try {
      await window.visualize.createSuccessors([{ type: 'execution',
        prompt: { text: '处理表单 source 中选择的图片', skillReferences: [], features: [], files: [] } }]);
      status.textContent = '已创建后继任务。';
    } catch (reason) { showError(reason); }
    finally { busy = false; source.disabled = images.length === 0; refresh.disabled = false; next.disabled = false; }
  };
})().catch(reason => { document.getElementById('error').textContent = reason.message; });
</script>`;

export function visualizeInputGuidance(): string {
  return [
    'Input sources are two RESOURCE ORIGINS, not two node types: project file references (文件引用) and fixed Work Graph resources (工作图资源, also called canvas resources in code). Both may be image/file/video nodes; never infer resource origin solely from node type or a link icon.',
    'Runtime input contract: const context = await window.visualizeReady; const result = await window.visualize.readInputs(false); const accepted = result.inputs; const items = accepted.inputs. context.inputs has this same VisualizeInputSnapshot shape. SDK results are direct values, NOT result.result or a bridge {ok,result} envelope. input.name is an inputBindings name or, without a binding, its edgeId. Only currently accepted inputs describe current connections.',
    'Complete readInputs(false) result example with BOTH image resource origins (illustrative IDs/digests/bytes only; copy actual provided values):\n```json\n' + JSON.stringify({ inputs: visualizeImageInputExample, inputsChanged: false }, null, 2) + '\n```',
    'Fixed resources live in input.resources[].resource: resourceId is a Work Graph resource ID, NOT an asset-library assetId; resource.version becomes asset.resourceVersion. File references may have resources:[]; projectFiles is the identity list and projectFileData contains the readable metadata and asset reference. Binary text is null; bytes travel separately, never base64. Text is in resources[].text or projectFileData[].text; a visualize predecessor also supplies form.data. Do not parse binary metadata as text or recursively mine old form selections/static dependencies as current connections.',
    'Reusable browser image collector for both resource origins. Filter by MIME, deduplicate by asset identity, keep metadata OUTSIDE the tagged asset, and fingerprint project files with changeToken/sha256 so replacing a file at the same path is detectable:\n```js\n' + visualizeCollectInputImagesExample + '\n```',
    'Page form declaration for a source field accepting either origin; use initialForm:{} until selected. This dialect has NO oneOf/anyOf/conditional required. The schema declares common required fields and branch fields as optional; the host tagged-asset validator separately requires exactly the correct branch keys and rejects missing/mixed keys and appended metadata even on form saves. Save source:selected.asset, never the whole collector entry, envelope, MIME/fingerprint or Blob URL:\n```json\n' + JSON.stringify(visualizeImageSourceForm, null, 2) + '\n```',
    'Minimal complete HTML example using that form declaration, dependencies:[], initialForm:{}, initialState:{}. Accepted inputs already authorize their media; do not duplicate them as hardcoded static dependencies. Restore a saved choice only if it remains in the accepted images; one image may be selected automatically, multiple images require explicit choice. If a business tool supports only one image, explain that constraint instead of silently selecting the first:\n```html\n' + visualizeImageSelectionHtmlExample + '\n```',
    'Refresh contract: readInputs(false) retains the accepted snapshot and reports inputsChanged/inputError; inputError is not an empty input list. readInputs(true) explicitly accepts a new snapshot; unchanged digest does not advance its version, and this does not overwrite form/state or start Runs. The current host reloads accepted input media and updates marker-to-Blob URLs before confirming an explicit SDK refresh when the input digest changed. Re-enumerate result.inputs, re-resolve each marker, and re-render even when a project path/marker is unchanged: changeToken/sha256 may have changed. visualizeAssetsReady is only initial readiness, not a new per-refresh Promise. Handle null URLs, decode failures and rejected SDK calls; if a fingerprint changed but its URL did not, disable that preview/export and suggest the HOST node-top 刷新输入 button or reopen, rather than claiming fresh pixels. Only show success after input read, actual media decode and any explicit save have completed. Host document reload also regenerates URLs. Poll with readInputs(false) to detect/report changes; accept only on an explicit refresh or a deliberate page policy, without automatic saves or task creation.',
  ].join('\n');
}
