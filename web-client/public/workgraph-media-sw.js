const prefix = '/__workgraph_media/';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  event.respondWith((async () => {
    const client = event.clientId && await self.clients.get(event.clientId);
    if (!client || event.request.method !== 'GET') return new Response(null,{status:404});
    const id = url.pathname.slice(prefix.length);
    if (!/^[0-9a-f-]{36}$/.test(id)) return new Response(null,{status:404});
    const channel = new MessageChannel();
    const reply = new Promise(resolve => {
      const timeout = setTimeout(() => resolve({error:'Video range timed out'}),30000);
      channel.port1.onmessage = message => { clearTimeout(timeout); resolve(message.data); };
    });
    client.postMessage({type:'workgraph-media-range',id,range:event.request.headers.get('Range')},[channel.port2]);
    const result = await reply;
    if (result.error || !(result.bytes instanceof ArrayBuffer)) return new Response(null,{status:502,headers:{'Cache-Control':'no-store'}});
    return new Response(result.bytes,{status:206,headers:{
      'Content-Type':result.mime || 'video/mp4',
      'Content-Length':String(result.bytes.byteLength),
      'Content-Range':`bytes ${result.start}-${result.end}/${result.total}`,
      'Accept-Ranges':'bytes',
      'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff',
    }});
  })());
});
