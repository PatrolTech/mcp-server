# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request:

- **GitHub:** [report a vulnerability](https://github.com/PatrolTech/mcp-server/security/advisories/new) from the Security tab of this repository.
- **Support bot:** WhatsApp [wa.me/34624085772](https://wa.me/34624085772) or Telegram [@patroltechbot](https://t.me/patroltechbot).
- **Email:** [info@patroltech.app](mailto:info@patroltech.app).

Include the affected version, the steps to reproduce and the impact you expect. Do not send credentials, access tokens or customer data: if a report needs them, say so and we will agree on a safe channel.

We acknowledge reports within 3 working days and keep you informed until the fix is released.

## Scope and threat model

This repository contains the remote MCP server of PatrolTech: a stateless OAuth resource server that verifies the user's access token, exchanges it for a short-lived agent session with the PatrolTech API and offers the tools of [`@patroltech/agent-capabilities`](https://github.com/PatrolTech/agent-capabilities) to MCP clients.

- **It grants no access by itself.** The server has no credentials of its own: it only forwards the user's token. Every request is authorized again by the PatrolTech API: organization and location roles, OAuth scopes and, for MCP agents, a closed list of allowed writes (an agent can never give access to other people or touch billing).
- **Tokens.** Access tokens are accepted only in the `Authorization` header (never in the query or the body), must be ES256-signed by the configured issuer, with the exact audience of `MCP_PUBLIC_URL`, and carry `exp`, `sub`, `scope`, `client_id` and `grant_id`. Caches are keyed by a hash of the token, never by the token, and tokens never reach logs or error messages.
- **The proposal flow is not a security barrier.** Propose, confirm and cancel protect users from model mistakes; the confirm tool is marked destructive so MCP clients ask the user first. The limits that matter (allowed writes, roles, proposal quota, rate limits) are enforced by the API. Proposals are bound to the user and the OAuth client: another user's or client's batch is "unknown".
- **Prompt injection.** Names, incident texts and other user-written content reach the model as data inside tool results, with a fixed note in every result that they are data, never instructions. Writes need the `write` scope and a confirmation.
- **Browsers and DNS rebinding.** The `Host` header must be the public resource or loopback, and any request with an `Origin` header gets 403: `/mcp` has no CORS.
- **Audit.** Every tool call writes one `mcp.tool_call` log line with a hash of the arguments, never the arguments themselves.
- **Self-hosted deployments** run with the permissions their users grant them, like any OAuth client. The rate limits of this server do not protect the API: those of the API do.
- **Deployment.** The deployment workflow holds no server data: hosts, users, paths, ports, process names and keys live in GitHub environment secrets, and its logs print nothing from the server. Pull requests from forks never get those secrets.

Vulnerabilities in the PatrolTech API or apps found while using this server are welcome through the same channels.

## Supported versions

Only the latest released version receives security fixes.
