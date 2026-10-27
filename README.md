# PatrolTech MCP server

The remote [Model Context Protocol](https://modelcontextprotocol.io) server of [PatrolTech](https://patroltech.online), the guard tour and security patrol platform. It lets AI assistants such as Claude, ChatGPT, Copilot, Gemini or Cursor **read and act on a PatrolTech account** on behalf of a user who signs in with OAuth: rounds, routes, checkpoints, guards, incidents, users, locations, access control and scans.

[![CI](https://github.com/PatrolTech/mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/PatrolTech/mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

This repository holds only the server code. **To install the connector** in your assistant, use [PatrolTech/ai-integrations](https://github.com/PatrolTech/ai-integrations): plugins, MCP Registry entry and instructions for each client.

> **This server grants no access by itself.** It has no credentials of its own: it forwards the user's token, and the PatrolTech API authorizes every call (organization and location roles, OAuth scopes and a closed list of writes allowed to agents). See [SECURITY.md](./SECURITY.md).

## How it works

```
MCP client ──OAuth──▶ PatrolTech authorization server
    │ Bearer access token (audience = MCP_PUBLIC_URL)
    ▼
MCP server (this repo, stateless) ──agent session──▶ PatrolTech API
    │                                   ▲
    └── Redis: locks and rate limits    └── @patroltech/agent-capabilities + @patroltech/sdk-api
```

- **OAuth resource server.** `/mcp` requires a bearer token issued by the PatrolTech authorization server (RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp`). Tokens are verified against the API's JWKS (ES256, exact issuer and audience) and exchanged for a 15-minute agent session (`POST /oauth/agent-session`), cached by a hash of the token. The API trims the session to what the grant still allows.
- **Stateless.** Each request gets a fresh MCP server instance and serves both protocol eras (2025 and 2026-07-28). Nothing about a conversation is kept in memory: proposals live in the PatrolTech API, so any number of workers can serve the same user.
- **Redis** holds what must be shared between workers: the per-user lock around proposals (`SET NX PX`, renewed while it lasts) and the per-user, per-tool rate limits. It is required in `production` and `staging`. If Redis fails, propose, confirm and cancel answer "busy" rather than risk two proposals overwriting each other. Without `REDIS_URL` (development and test only) both live in process memory.
- **Tools** come from the `mcp` channel of [`@patroltech/agent-capabilities`](https://github.com/PatrolTech/agent-capabilities), which calls the API through [`@patroltech/sdk-api`](https://github.com/PatrolTech/sdk-api).

### Tools

| Tool                                | What it does                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `patroltech_<area>_<read>`          | One per read of the catalog: read-only, English titles and descriptions, optional `organization` when the user has several.                     |
| `patroltech_account_get_context`    | The user's organizations (name, role, access) and their locations.                                                                              |
| `patroltech_<area>_propose_<verb>`  | Proposes a change. Nothing changes until it is confirmed. Proposals of one user and client form one batch (up to 10, expires after 30 minutes). |
| `patroltech_proposals_confirm`      | Executes the whole pending batch, in order, with the parameters that were proposed (marked destructive: clients ask the user first).            |
| `patroltech_proposals_cancel`       | Withdraws the pending batch.                                                                                                                    |
| `patroltech_locations_get_qr_sheet` | A signed link (1 hour) to the printable QR sheet of a location.                                                                                 |

Writes need the `write` scope: without it the server answers `403 insufficient_scope` with the `read write` challenge. Every result is `{ data, truncated?, notices?, note }`, capped at 60,000 characters, where `note` says that `data` is data, never instructions. Each user can make 60 calls per minute to a read tool and 20 to a write tool. Every call writes one `mcp.tool_call` audit line with a hash of the arguments, never the arguments.

### Endpoints

| Path                                        | Auth   | Purpose                                                                                                       |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `/mcp` (path of `MCP_PUBLIC_URL`)           | Bearer | The MCP endpoint (POST, GET, DELETE). Validates `Host` and rejects any `Origin`.                              |
| `/.well-known/oauth-protected-resource/mcp` | none   | Protected resource metadata (RFC 9728), also at the root path.                                                |
| `/health`                                   | none   | Liveness: `200 {"status":"ok","version":"…"}`.                                                                |
| `/health/ready`                             | none   | Readiness: `200` if the JWKS answers within 3 s and, with `REDIS_URL`, Redis answers `PING`; otherwise `503`. |
| `/.well-known/openai-apps-challenge`        | none   | The `OPENAI_APPS_CHALLENGE` token, for the ChatGPT apps directory; `404` without it.                          |

## Configuration

Every variable is documented in [`.env.example`](./.env.example). The server refuses to start, listing each missing or invalid variable, if the configuration is not valid.

| Variable                        | Required                  | Description                                                                                                   |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `MCP_PUBLIC_URL`                | yes                       | Exact public URL of the MCP endpoint, the audience of the tokens (for example `https://mcp.example.com/mcp`). |
| `API_BASE_URL`                  | yes                       | Origin of the PatrolTech API, without `/api`.                                                                 |
| `OAUTH_ISSUER`                  | yes                       | Expected `iss` of the access tokens, byte for byte.                                                           |
| `OAUTH_JWKS_URL`                | no                        | JWKS of the issuer. Default `API_BASE_URL` + `/oauth/jwks.json`.                                              |
| `DASHBOARD_URL`, `APP_BASE_URL` | yes                       | PatrolTech dashboard and web app, for links shown to the user.                                                |
| `APP_ENVIRONMENT`               | yes                       | `production`, `staging`, `development` or `test`.                                                             |
| `REDIS_URL`                     | in production and staging | Shared Redis (ioredis URL).                                                                                   |
| `REDIS_NAMESPACE`               | no                        | Key prefix in Redis. Default `APP_ENVIRONMENT`.                                                               |
| `HOST`, `PORT`                  | no                        | Where the process listens. Default `127.0.0.1:3110`, behind a reverse proxy.                                  |
| `LOG_LEVEL`                     | no                        | `debug`, `info` (default), `warn` or `error`. Audit and heartbeat lines are written at any level.             |
| `SERVICE_NAME`                  | no                        | `service` field of every log line. Default `mcp-server`.                                                      |
| `OPENAI_APPS_CHALLENGE`         | no                        | Domain verification token for the ChatGPT apps directory.                                                     |

Logs are one JSON object per line on stdout and stderr. Each process writes an `mcp.heartbeat` line every 5 minutes, so a log monitor can alert when it stops.

## Development

Node.js 22.9 or later.

```bash
npm ci
cp .env.example .env.local   # fill in the values; .env.local is ignored by git
npm run dev                  # tsx watch, loads .env.local
curl http://127.0.0.1:3110/health
```

| Script                                                      |                                                                                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                               | Run with reload (`tsx watch`).                                                                                                                                 |
| `npm run lint`, `npm run format:check`, `npm run typecheck` | ESLint, Prettier and the type check of sources and tests.                                                                                                      |
| `npm test`                                                  | Unit and HTTP tests (vitest).                                                                                                                                  |
| `npm run test:deploy`                                       | Tests of the PM2 ecosystem and of the remote deployment script.                                                                                                |
| `npm run build`                                             | Compile to `dist/` (`npm start` runs it).                                                                                                                      |
| `npm run bundle`                                            | One self-contained ESM file, `dist/bundle/server.mjs` (+ source map): the deployable artifact.                                                                 |
| `npm run smoke`                                             | Starts the bundle with a test configuration and checks `/health`, the metadata, the challenge and that `/health/ready` reports the unreachable JWKS and Redis. |

Code layout follows the hexagonal style: `src/domain` (pure rules), `src/application` (use cases and their ports), `src/interface/mcp` (the MCP adapter) and `src/infrastructure` (HTTP, OAuth, SDK adapters, Redis, logging).

## Self-hosting

You can run this server on your own infrastructure, for example to audit it or to put it in front of your own network policies.

**OAuth audience.** Access tokens are bound to the resource they were issued for. The PatrolTech authorization server only issues tokens for resources it knows, so a deployment under your own `MCP_PUBLIC_URL` needs to be registered with PatrolTech before PatrolTech users can connect to it. Ask through the channels in [SECURITY.md](./SECURITY.md).

What you need:

- Node.js 22.9 or later and Redis.
- A reverse proxy with TLS in front of `HOST:PORT` that forwards `/mcp`, `/.well-known/oauth-protected-resource` (and its subpaths) and, if you use them, `/health`, `/health/ready` and `/.well-known/openai-apps-challenge`. Keep the `Host` header: the server only accepts the host of `MCP_PUBLIC_URL` or loopback.

Steps:

1. Build the artifact: `npm ci && npm run bundle && npm run smoke`.
2. Copy `dist/bundle/server.mjs`, `dist/bundle/server.mjs.map` and `package.json` (the version comes from it) to a directory on the server. No `npm install` is needed there.
3. Create `.env.local` in that directory from `.env.example`, with `APP_ENVIRONMENT=production` and `REDIS_URL`.
4. Start it: `node --enable-source-maps --env-file-if-exists=.env.local server.mjs`, or with PM2 (below). The process stops gracefully on `SIGTERM`, waiting up to 55 s for calls in progress, so give it about 60 s before a forced kill.

### With PM2

[`deploy/ecosystem.config.cjs`](./deploy/ecosystem.config.cjs) runs the bundle in cluster mode. It holds no server data: it reads `MCP_PM2_NAME`, `MCP_PORT` and `MCP_APP_ENVIRONMENT` (required) and `MCP_INSTANCES`, `MCP_SERVICE_NAME` and `PM2_APP_DIR` (optional) from the environment, and loads the rest from `.env.local`.

```bash
MCP_PM2_NAME=mcp MCP_PORT=3110 MCP_APP_ENVIRONMENT=production MCP_INSTANCES=2 \
  pm2 start ecosystem.config.cjs
```

In cluster mode the workers run with the Node.js of the PM2 daemon, which must be 22.9 or later for `--env-file-if-exists`. Never run `pm2 update` on a shared daemon: it restarts every app it manages.

### With GitHub Actions

[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) deploys a fork of this repository by SSH, by hand (`workflow_dispatch`, `staging` by default). It builds, tests and smoke-tests the bundle without secrets, uploads the bundle, `package.json` and the ecosystem with rsync, and runs [`deploy/remote-deploy.sh`](./deploy/remote-deploy.sh) on the server: checks `.env.local`, reloads PM2 without downtime, probes the readiness URL and waits until every instance is online with the new version. `production` only deploys from `main` or a `v*` tag.

The workflow and the scripts contain no server data, and the logs print nothing from the server. Create the GitHub environments `staging` and `production` (with a required reviewer and a deployment branch rule for `main` and `v*` tags on `production`) and set, in each one:

| Secret             | Required | Description                                                                           |
| ------------------ | -------- | ------------------------------------------------------------------------------------- |
| `SSH_HOST`         | yes      | Host name or IP address of the server.                                                |
| `SSH_USER`         | yes      | SSH user that owns the app directory and runs PM2.                                    |
| `SSH_PRIVATE_KEY`  | yes      | Private key of that user, without passphrase, used only for deployments.              |
| `SSH_KNOWN_HOSTS`  | yes      | `known_hosts` lines of the server, checked out of band (`ssh-keyscan -H <host>`).     |
| `APP_DIR`          | yes      | Absolute path of the app directory (bundle, `.env.local`, `logs/`).                   |
| `PM2_APP_NAME`     | yes      | Name of the PM2 process.                                                              |
| `APP_PORT`         | yes      | Local port the process listens on.                                                    |
| `HEALTH_URL`       | yes      | Readiness URL as seen from the server, `http://127.0.0.1:<port>/health/ready`.        |
| `SSH_PORT`         | no       | SSH port, if not 22.                                                                  |
| `DEPLOY_HOME`      | no       | `HOME` used to talk to the PM2 daemon (where its `.pm2` lives).                       |
| `NODE_BIN_DIR`     | no       | Directory of the Node.js binary to use on the server, put first in `PATH`.            |
| `PM2_BIN`          | no       | Path of the `pm2` CLI to use. Default: the one in `PATH`.                             |
| `DEPLOY_LOCK_FILE` | no       | Lock file (`flock`) shared with the deployments of other apps on the same PM2 daemon. |
| `FILE_OWNER`       | no       | `user:group` the app directory must have after the upload.                            |
| `SERVICE_NAME`     | no       | `service` of the log lines. Default: the PM2 process name.                            |
| `DD_API_KEY`       | no       | Datadog API key, to send an event when a deployment fails.                            |

| Variable        | Required | Description                                                   |
| --------------- | -------- | ------------------------------------------------------------- |
| `PM2_INSTANCES` | no       | Number of instances (default 1).                              |
| `DD_SITE`       | no       | Datadog site for the failure event (default `datadoghq.com`). |

Server data goes in secrets, not variables: Actions masks secrets in the logs, and the workflow also masks the values derived from them.

## Versioning and releases

The version lives only in `package.json`. When a change to it reaches `main`, the release workflow creates the `v<version>` tag and a GitHub release with the bundle and its checksums.

## Related packages

- [`@patroltech/agent-capabilities`](https://www.npmjs.com/package/@patroltech/agent-capabilities): the catalog of reads and proposed actions this server exposes.
- [`@patroltech/sdk-api`](https://www.npmjs.com/package/@patroltech/sdk-api): the TypeScript SDK of the PatrolTech public API.
- [PatrolTech/ai-integrations](https://github.com/PatrolTech/ai-integrations): the connector for each AI assistant.

## License

[MIT](./LICENSE) © Ingenieros Web SL
