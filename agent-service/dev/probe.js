const KEY = 'openworkgraph:protocol-probe:session:v1';
const field = id => document.getElementById(id);
field('origin').textContent = location.origin;
field('command').textContent = 'node agent-service/dist/cli.js pair-code --origin ' + location.origin + ' --data-dir <同一数据目录>';
let saved = null;
let generation = 0;
function status(message) { field('status').textContent = message; }
function clearSession() { saved = null; localStorage.removeItem(KEY); field('sessions').textContent = ''; }
function endpoint(input) {
  const parsed = new URL(input);
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('服务地址只能包含 http(s)://主机:端口。');
  return parsed.origin;
}
async function api(record,path,options = {}) {
  const response = await fetch(record.endpoint+path,{...options,credentials:'omit',redirect:'error',cache:'no-store',headers:{'X-Workgraph-Protocol':'1.0','X-Workgraph-Service-Id':record.serviceId,...(record.token ? {Authorization:'Bearer '+record.token} : {}),...options.headers}});
  if (!response.ok) {
    const failure = await response.json();
    const error = new Error(failure.error?.message ?? '请求失败'); error.code = failure.error?.code; throw error;
  }
  return response.status === 204 ? null : response.json();
}
function failed(error,version) {
  if (version !== generation) return;
  if (['UNAUTHENTICATED','SESSION_EXPIRED','SESSION_REVOKED'].includes(error.code)) clearSession();
  status((error.code ? error.code+': ' : '')+error.message+'；网络错误时请检查来源、地址、防火墙和浏览器控制台。');
}
async function refresh() {
  const version = ++generation;
  if (!saved) { status('尚未配对，请先填写本机命令输出。'); return; }
  const record = saved;
  try {
    const session = await api(record,'/v1/session');
    const sessions = await api(record,'/v1/sessions');
    if (version !== generation) return;
    field('sessions').textContent = JSON.stringify(sessions,null,2);
    status('会话已恢复：'+session.browserName+'；到期时间：'+session.expiresAt);
  } catch (error) { failed(error,version); }
}
field('pair-form').addEventListener('submit',async event => {
  event.preventDefault(); const version = ++generation;
  try {
    const record = {endpoint:endpoint(field('endpoint').value),serviceId:field('service-id').value.trim()};
    const result = await api(record,'/v1/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:field('pair-code').value.trim(),browserName:field('browser-name').value,expectedServiceId:record.serviceId})});
    field('pair-code').value = '';
    if (version !== generation) return;
    if (result.serviceId !== record.serviceId || typeof result.token !== 'string') throw new Error('配对响应身份不匹配，未保存会话。');
    saved = {...record,token:result.token}; localStorage.setItem(KEY,JSON.stringify(saved));
    await refresh();
  } catch (error) { failed(error,version); }
});
field('refresh').addEventListener('click',refresh);
field('revoke').addEventListener('click',async () => {
  if (!saved) { status('没有可撤销的当前会话。'); return; }
  const version = ++generation; const record = saved;
  try {
    const current = await api(record,'/v1/session');
    await api(record,'/v1/sessions/'+current.id,{method:'DELETE'});
    if (version !== generation) return;
    clearSession(); status('当前会话已撤销；已接受任务不受影响。');
  } catch (error) { failed(error,version); }
});
window.addEventListener('storage',event => {
  if (event.key === KEY) { generation++; saved = null; field('sessions').textContent = ''; status('另一标签页改变了会话，请刷新页面恢复。'); }
});
try {
  const value = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  if (value && typeof value.token === 'string' && typeof value.serviceId === 'string' && endpoint(value.endpoint) === value.endpoint) {
    saved = value; field('endpoint').value = value.endpoint; field('service-id').value = value.serviceId; void refresh();
  }
} catch { status('无法读取本地会话，请重新配对。'); }
