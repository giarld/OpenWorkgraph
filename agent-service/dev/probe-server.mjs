import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
const {values} = parseArgs({options:{host:{type:'string',default:'127.0.0.1'},port:{type:'string',default:'5173'}}});
if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new Error('Invalid port');
const files = new Map([['/',['probe.html','text/html']],['/probe.js',['probe.js','text/javascript']],['/probe.css',['probe.css','text/css']]].map(([path,[file,mime]]) => [path,{body:readFileSync(new URL(file,import.meta.url)),mime}]));
const server = createServer((request,response) => {
  const file = request.method === 'GET' && files.get(request.url);
  if (!file) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type',file.mime+'; charset=utf-8');
  response.setHeader('Cache-Control','no-store');
  response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src http: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.end(file.body);
});
server.listen(Number(values.port),values.host,() => console.log(JSON.stringify(server.address())));
process.once('SIGTERM',() => server.close()); process.once('SIGINT',() => server.close());
