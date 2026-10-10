import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { validateVisualizeForm, VisualizeValidationError } from '@openworkgraph/protocol';
import type { FrozenVisualizeInput, InputSnapshot, Json, Run, VisualizeResourceReference } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { canonicalJson } from './persistence/repositories.js';
import { readVisualizeBusinessForm, resolveVisualizeFormAssets, validateStoredVisualizeContent } from './visualize-content.js';

/** Called only inside the launch transaction. Select submitted sources, never new edges. */
export function freezeVisualizeRunInputs(db: DatabaseSync, run: Run, submitted: InputSnapshot): void {
  if (!submitted.visualizeBindings?.length || submitted.frozenVisualizeInputs) return;
  const snapshot = structuredClone(submitted);
  const frozen: FrozenVisualizeInput[] = [];
  const replaced = new Set(submitted.visualizeBindings.flatMap(binding => binding.resourceIndexes));
  const sourceIds = new Set(submitted.visualizeBindings.map(binding => binding.sourceNodeId));
  for (const index of replaced) {
    const resource = snapshot.resources[index];
    if (!Number.isSafeInteger(index) || index < 0 || !resource || !resource.sourceNodeIds.some(id => sourceIds.has(id)))
      throw new ServiceError('INPUT_BLOCKED', '可视化提交输入身份不完整。');
  }
  snapshot.resources = snapshot.resources.flatMap((resource, index) => {
    if (!replaced.has(index)) return [resource];
    const remaining = resource.sourceNodeIds.filter(id => !sourceIds.has(id));
    return remaining.length ? [{ ...resource, sourceNodeIds: remaining }] : [];
  });
  const replacedFiles = new Set(submitted.visualizeBindings.flatMap(binding => binding.projectFileIndexes ?? []));
  for (const index of replacedFiles) {
    const file = snapshot.projectFiles?.[index];
    if (!Number.isSafeInteger(index) || index < 0 || !file || !file.sourceNodeIds.some(id => sourceIds.has(id))) throw new ServiceError('INPUT_BLOCKED', '可视化项目文件输入身份不完整。');
  }
  snapshot.projectFiles = (snapshot.projectFiles ?? []).flatMap((file, index) => {
    if (!replacedFiles.has(index)) return [file];
    const remaining = file.sourceNodeIds.filter(id => !sourceIds.has(id));
    const removedEdges = new Set(submitted.visualizeBindings!.flatMap(binding => binding.edgeIds));
    return remaining.length ? [{ ...file, sourceNodeIds: remaining, edgeIds: file.edgeIds.filter(id => !removedEdges.has(id)) }] : [];
  });
  const references: VisualizeResourceReference[] = [];
  for (const binding of submitted.visualizeBindings) {
    const row = db.prepare("SELECT n.current_version,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=? AND n.type='visualize' AND n.deleted=0").get(binding.sourceNodeId, run.graphId);
    if (!row) throw new ServiceError('INPUT_BLOCKED', '可视化前驱已删除或不可用。', { details: { sourceNodeId: binding.sourceNodeId } });
    const { content, page } = validateStoredVisualizeContent(db, run, JSON.parse(String(row.content)));
    if (!page || !content.page || !content.form) throw new ServiceError('INPUT_BLOCKED', '可视化前驱尚未保存业务表单。');
    try { validateVisualizeForm(page.form.schema, content.form.data, 'execute'); }
    catch (error) {
      if (!(error instanceof VisualizeValidationError)) throw error;
      throw new ServiceError('INPUT_BLOCKED', '可视化前驱表单未通过执行校验。', { details: { sourceNodeId: binding.sourceNodeId, visualizeCode: error.code, fields: error.fields as unknown as Json } });
    }
    const business = readVisualizeBusinessForm(db, run, content);
    const assets = resolveVisualizeFormAssets(db, run, business.form.data);
    if (snapshot.imageRoute?.type === 'api' && assets.projectFiles.length)
      throw new ServiceError('INPUT_BLOCKED', 'API 生图不能读取项目文件引用，请使用 Codex。', { details: { sourceNodeId: binding.sourceNodeId } });
    for (const asset of assets.resources) {
      snapshot.resources.push({ ...asset, sourceNodeIds: [binding.sourceNodeId] });
      references.push({ resourceId: asset.resource!.resourceId, resourceVersion: asset.resource!.version });
    }
    for (const asset of assets.projectFiles) snapshot.projectFiles.push({ ...asset, sourceNodeIds: [binding.sourceNodeId], edgeIds: [...binding.edgeIds] });
    // Stored JSON representations alone cannot prove the backing immutable bytes still exist.
    for (const reference of [content.page.resource, content.form.resource]) {
      const blob = db.prepare('SELECT v.sha256,b.bytes,f.path FROM canvas_resource_versions v JOIN blobs b ON b.sha256=v.sha256 JOIN resource_blob_files f ON f.sha256=v.sha256 WHERE v.resource_id=? AND v.version=?').get(reference.resourceId, reference.resourceVersion);
      try {
        if (!blob || Number(blob.bytes) > 4_194_304) throw new Error('Missing or oversized JSON');
        const fd = openSync(String(blob.path), 'r');
        let bytes: Buffer;
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size !== Number(blob.bytes)) throw new Error('Invalid JSON file');
          bytes = Buffer.alloc(Number(blob.bytes));
          let offset = 0;
          while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count) throw new Error('Truncated JSON file');
            offset += count;
          }
        } finally { closeSync(fd); }
        if (bytes.length !== Number(blob.bytes) || createHash('sha256').update(bytes).digest('hex') !== blob.sha256) throw new Error('Invalid JSON bytes');
      } catch { throw new ServiceError('INPUT_BLOCKED', '可视化页面或表单固定资源不可读。', { details: { sourceNodeId: binding.sourceNodeId } }); }
      references.push(reference);
    }
    snapshot.resources.push({ kind: 'text', sourceNodeIds: [binding.sourceNodeId], text: canonicalJson(business.form.data), resource: business.resource });
    frozen.push({ sourceNodeId: binding.sourceNodeId, edgeIds: [...binding.edgeIds], contentVersion: Number(row.current_version), page: { revision: content.page.revision, resource: content.page.resource }, schema: page.form, form: business.form });
  }
  const uniqueResources = new Map<string, InputSnapshot['resources'][number]>();
  for (const resource of snapshot.resources) {
    const key = canonicalJson([resource.kind, resource.text ?? null, resource.resource ?? null] as unknown as Json);
    const existing = uniqueResources.get(key);
    if (existing) existing.sourceNodeIds = [...new Set([...existing.sourceNodeIds, ...resource.sourceNodeIds])];
    else uniqueResources.set(key, resource);
  }
  snapshot.resources = [...uniqueResources.values()];
  const uniqueFiles = new Map<string, NonNullable<InputSnapshot['projectFiles']>[number]>();
  for (const file of snapshot.projectFiles) {
    const key = JSON.stringify([file.kind, file.relativePath]);
    const existing = uniqueFiles.get(key);
    if (existing) { existing.sourceNodeIds = [...new Set([...existing.sourceNodeIds, ...file.sourceNodeIds])]; existing.edgeIds = [...new Set([...existing.edgeIds, ...file.edgeIds])]; }
    else uniqueFiles.set(key, file);
  }
  snapshot.projectFiles = [...uniqueFiles.values()];
  if (snapshot.imageRoute || snapshot.inputMode !== undefined) {
    const hasImage = snapshot.resources.some(resource => resource.kind === 'image' && resource.resource) || snapshot.imageRoute?.type !== 'api' && snapshot.projectFiles.some(file => file.kind === 'image');
    snapshot.inputMode = hasImage ? (snapshot.prompt.trim() ? 'text_image' : 'image') : 'text';
  }
  const textBytes = snapshot.resources.reduce((sum, resource) => sum + Buffer.byteLength(resource.text ?? ''), Buffer.byteLength(snapshot.prompt));
  const resourceBytes = snapshot.resources.reduce((sum, resource) => sum + (resource.resource?.bytes ?? 0), 0);
  if (snapshot.resources.length + snapshot.projectFiles.length > 64 || textBytes > 33_554_432 || resourceBytes > 134_217_728 || snapshot.resources.some(resource => Buffer.byteLength(resource.text ?? '') > 8_388_608 || (resource.resource?.bytes ?? 0) > 52_428_800))
    throw new ServiceError('INPUT_BUDGET_EXCEEDED', '启动时的可视化表单超过输入预算。');
  snapshot.frozenVisualizeInputs = frozen;
  const { inputDigest: baseInputDigest, ...body } = snapshot;
  snapshot.inputDigest = createHash('sha256').update(canonicalJson({ baseInputDigest, ...body } as unknown as Json)).digest('hex');
  db.prepare('INSERT INTO launch_input_snapshots(run_id,payload) VALUES(?,?)').run(run.id, canonicalJson(snapshot as unknown as Json));
  db.prepare('UPDATE runs SET input_digest=? WHERE id=?').run(snapshot.inputDigest, run.id);
  for (const reference of references) {
    if (!db.prepare("SELECT 1 FROM canvas_resource_references WHERE run_id=? AND resource_id=? AND resource_version=? AND owner_kind='snapshot'").get(run.id, reference.resourceId, reference.resourceVersion))
      db.prepare("INSERT INTO canvas_resource_references(id,resource_id,resource_version,graph_id,owner_kind,run_id) VALUES(?,?,?,?,'snapshot',?)").run(randomUUID(), reference.resourceId, reference.resourceVersion, run.graphId, run.id);
  }
}
