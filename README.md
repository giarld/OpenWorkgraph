# OpenWorkgraph

OpenWorkgraph is an all-purpose visual agent workbench built around the infinite canvas concept. Beyond image, text, and video generation and software development, it helps you organize agent workflows for a wide range of purposes.

> [!IMPORTANT]
> Visual Agent Workbench
>
> AI creates all things. All things converge in the forge.

English | [简体中文](README.zh-CN.md)

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

### OpenCode Agent

OpenWorkgraph configures its OpenCode integration dependencies during installation; no separate SDK installation is needed. Stable OpenCode versions >= 2.0.0 are supported. Each execution owns a separate native instance; existing user sessions are not taken over. Configure providers, models and authentication through native OpenCode on the Workspace device, then enable OpenCode and choose its model in Agent settings. Web tasks use the fixed build role and the same reasoning effort selector as Codex before submission; the plugin translates the selection into a native model variant. Catalog queries do not run model inference. If the integration is incomplete, run `npm install -g openworkgraph --include=optional` on the Workspace device, restart the Workspace and refresh the Agent catalog. Explicitly omitting optional dependencies skips OpenCode integration.

Execution, text and visualization delivery are supported; OpenCode image generation is excluded. Workspace write mode uses native file rules and command approvals, without an OS sandbox. Read-only mode is currently unsupported. Full access automatically approves eligible permission requests while preserving native hard denials; user questions still require an answer. Advanced session, revert and terminal operations are available through the backend API, with no additional Web controls.

After a crash, unresolved independent work retains the project lock and execution capacity. Inspect and stop the original work before using revision-checked recovery operations; do not release occupancy by editing the database. See the [OpenCode capability reference](docs/development/opencode-plugin-capabilities.md) and [Run and recovery operations](docs/development/opencode-run-operations.md) for installation and platform boundaries.

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
