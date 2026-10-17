import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const sdk = await build({ absWorkingDir: root, entryPoints: ['packages/protocol/src/visualize-sdk.ts'], bundle: true, write: false, format: 'iife', globalName: 'VisualizeProtocol', target: 'es2022', minify: true });
await build({
  absWorkingDir: root, entryPoints: ['web-client/src/real/visualize-preview-host.ts'],
  bundle: true, format: 'iife', target: 'es2022', minify: true,
  outfile: 'agent-service/dist/visualize-preview/host.js',
  define: { __VISUALIZE_PREVIEW_SDK__: JSON.stringify(sdk.outputFiles[0].text) },
  plugins: [{ name: 'raw-css', setup(builder) {
    builder.onLoad({ filter: /[.]css$/, namespace: 'file' }, async ({ path }) => ({ contents: await readFile(path, 'utf8'), loader: 'text' }));
  } }],
});
