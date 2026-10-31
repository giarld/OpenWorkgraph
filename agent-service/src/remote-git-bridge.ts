/** Child-process bridge. Credentials stay in the parent process. */
import { connect } from 'node:net';
const port = Number(process.env['OPENWORKGRAPH_GIT_BRIDGE_PORT']);
const secret = process.env['OPENWORKGRAPH_GIT_BRIDGE_KEY'];
if (!port || !secret) process.exit(1);
const ask = process.argv[2] === 'askpass';
const socket = connect(port, '127.0.0.1');
socket.on('connect', () => {
  socket.write(JSON.stringify({ secret, mode: ask ? 'askpass' : 'ssh', prompt: ask ? process.argv.slice(3).join(' ') : '' }) + '\n');
  if (!ask) process.stdin.pipe(socket); else socket.end();
});
socket.pipe(process.stdout);
socket.on('error', () => process.exit(1));
socket.on('end', () => process.exit(0));
