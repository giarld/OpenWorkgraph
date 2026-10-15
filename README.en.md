# OpenWorkgraph

> [!IMPORTANT]
> OpenWorkgraph is an all-purpose visual agent workbench built around the infinite canvas concept. Beyond image, text, and video generation and software development, it helps you organize agent workflows for a wide range of purposes.
>
> Visual Agent Workbench
> AI is the magic of creation. Workgraph puts the wand in your hands.

[简体中文](README.md) | English

## Quick Start

Open the [official OpenWorkgraph editor](https://canvas.giarld.com) and follow the on-screen setup guide to get started.

## Design Philosophy: First Principles

![Input is transformed by a system into output](assets/readme/first-principles.png)

## Build and Run Locally

### Agent Service

Build the protocol package and Agent Service from the repository root:

```sh
npm ci --include=dev
npm run build
```

After the build completes, run Agent Service in the foreground:

```sh
node agent-service/dist/cli.js start
```

### Web Client

Build Web Client from the repository root, then serve the production build with Vite Preview at `http://127.0.0.1:4173`:

```sh
npm --prefix web-client ci --include=dev
npm run build:web
npm --prefix web-client run preview -- --host 127.0.0.1 --port 4173
```

Web Client has separate dependencies and a lockfile; running `npm ci` at the root does not install them. Run the Web installation command above before the first build. `--include=dev` installs build tools such as TypeScript and Vite. Building only Web does not require an Agent Service build.

After opening Web Client, enter the Workspace address and click “Generate client code.” Run the following command on the machine hosting the Workspace, using the 8-digit client code shown in the browser. Verify the origin and public key fingerprint before approving. The browser polls for approval, proves possession of the private key, exchanges communication credentials, and then connects automatically:

```sh
node agent-service/dist/cli.js pair --client-code '<client-code>'
```

The client code consists of 8 consecutive digits, such as `12345678`, with no spaces, and expires after 5 minutes. By default, the terminal displays a human-readable approval result in English. Add `--output-json` only when a script needs to parse the result; non-interactive approval also requires `--yes`.

Only one service runs per machine. The `--data-dir` option is available only for `start` and `serve`. After a successful start, the directory is remembered automatically, so pairing, status, stop, logs, and backup commands do not need it. Running `start` after stopping the service reuses the previous directory. On the first start, if no directory is specified, the default is `.openworkgraph` in the user's home directory. Attempts to start a second service are explicitly rejected; there is no service selection or switching step.

You do not need to enter `--origin` manually. HTTPS is not required, and plain HTTP is supported on trusted local networks. HTTP traffic is unencrypted; do not expose it to the public internet.

### Checks and Tests

```sh
npm test
npm --prefix web-client run typecheck
npm --prefix web-client test
npm --prefix web-client run build
npm --prefix web-client run test:e2e
```

Run these commands from the repository root. The Web build output is written to `web-client/dist/`, and browser tests use an installed copy of Chrome.

## References and Acknowledgments

The Web UI draws on the visual style and canvas interactions of [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas). Thanks to the original author, basketikun. That project is licensed under the [MIT License](https://github.com/basketikun/infinite-canvas/blob/d213a74614e0e4bd8a26383d1e1e907249e9c61b/LICENSE). When reusing its code or other applicable content, retain the original copyright and license notices. Third-party assets with separate licenses remain subject to their respective terms.

## License

This project is licensed under the [MIT License](LICENSE). Copyright and license notices for third-party sources are retained with their original attribution.

## Current Phase 3 implementation and limits (2026-10-13)

The production registry includes Codex and Claude Code plugins. Claude CLI must be installed and authenticated separately on the Workspace machine. The plugin supports execution, text and visualize generation, native commands/network tools, background tasks, approvals/questions, skills/configuration, protected native skill commands and session recovery. Full access automatically approves permission requests; questions still require answers. Image generation and OS sandboxing are excluded. Video/Office decoding needs device tools; declared Linux/Windows support is separate from device validation. See [Claude plugin capabilities](docs/development/claude-plugin-capabilities.md).

The native model/effort catalog uses control initialize without inference and preserves native order. The complete plugin requires CLI 2.1.296 or newer. Actual macOS questions, page publication and configured native commands passed on October 14, 2026; version/catalog checks still do not establish every model or platform as healthy. Credentials, executable paths and env values remain outside Web options and frozen snapshots. Managed hooks and complete device matrices need separate validation.

New settings use independent config/agent-configuration.sqlite storage, generation agent-configuration-v1, and section CAS via GET/POST /v1/agents/configuration. They do not read or migrate legacy settings. Legacy APIs, requests omitting agent and the image route retain their semantics. New submissions explicitly carry generation, backend revision and shared permissions, checked and frozen at acceptance; later changes do not rewrite accepted runs.

Shared project modes can be saved as read-only/workspace-write/danger-full-access, with runs always read-write. Saving a mode does not establish native support by all plugins. Current Codex policies cannot combine a read-only project with writable runs, so new-generation Codex submissions reject that combination with capability_unsupported. A Workspace containing Codex can still save shared read-only settings and the UI can explain the limit. Codex workspace-write/full work; legacy semantics remain. Claude maps file access to native Edit rules. Workspace-write uses native permissions and Web approvals; full access automatically approves permission requests. Read-only denies project edits and command/Agent tools. No OS command sandbox is provided.

restoredRunStart means rechecking and starting a restored frozen backup run, not --resume, conversation continuation or reattachment. Unknown outcomes retain ownership; no silent plugin switching or invented recovery. Publication still validates delivery. See [native evidence and gaps](docs/validation/agent-plugin-phase-3.md) and [package validation](docs/validation/agent-plugin-phase-3-packaging.md).
