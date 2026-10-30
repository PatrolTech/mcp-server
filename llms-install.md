# Connect PatrolTech to an MCP client

Use this guide to connect an existing PatrolTech account to the hosted MCP server. You do not need to clone, build or deploy the server, install the TypeScript SDK, or provide an API key.

- Server name: `patroltech`
- Endpoint: `https://mcp.patroltech.online/mcp`
- Transport: Streamable HTTP
- Authentication: OAuth through the user's PatrolTech account
- Account requirement: a PatrolTech account with access to an organization; the free plan is supported

[Connection guide](https://patroltech.online/en/features/integrations/mcp?utm_source=github&utm_medium=referral&utm_campaign=ai_integrations&utm_content=llms_install_guide) | [Create a free account](https://patroltech.online/en/start?utm_source=github&utm_medium=referral&utm_campaign=ai_integrations&utm_content=llms_install_signup)

## Add the hosted server

In your client's MCP settings, add a remote server with the name, URL and transport above. Clients that read `mcpServers` configuration can use:

```json
{
  "mcpServers": {
    "patroltech": {
      "type": "streamableHttp",
      "url": "https://mcp.patroltech.online/mcp"
    }
  }
}
```

Use the client's native remote-server UI if its configuration schema differs. Keep the endpoint exactly as shown; campaign parameters belong on website links, not MCP or OAuth URLs.

## Cline

In Cline's MCP Servers panel, open Remote Servers, enter `patroltech` and the endpoint, select Streamable HTTP, and add the server. Complete OAuth authorization when prompted.

With an installed Cline CLI, you can also save the configuration noninteractively:

```sh
cline mcp add patroltech https://mcp.patroltech.online/mcp --transport http --yes
```

Then run `cline mcp` and choose Authorize OAuth for `patroltech` if authorization is pending. A successful installation message confirms configuration only; verify authentication and a read below before treating the connection as operational.

Cline CLI 3.0.74 accepted the command above in an isolated profile on 2026-10-30. An authenticated tool call in Cline is not yet verified. See [Cline's MCP documentation](https://docs.cline.bot/mcp/mcp-overview) for client configuration details.

## Authorize and verify

1. Open the authorization page supplied by your client. Sign in directly to PatrolTech and review the requested permissions before granting access. Never paste a password into a chat or a configuration file.
2. Load the tool list and call `patroltech_account_get_context`. Only organizations and locations available to the signed-in user's role should appear.
3. Select an organization you are authorized to use. Ask for recent rounds or incidents and check the result against your PatrolTech dashboard. An empty result can be valid when the account has no records.
4. If testing a supported change, ask for a proposal, inspect it and cancel it. Applying a proposal requires the user's explicit confirmation.

## Troubleshooting and limits

- HTTP 401 or an authorization prompt: complete or renew OAuth in the client.
- No available organizations: check the account and its roles in PatrolTech.
- HTTP 403 for a write: the grant or role may not allow that operation. Do not broaden access automatically.
- Connection errors: check that the client supports Streamable HTTP and remote OAuth; use the public endpoint, not a localhost development URL.
- Do not disable TLS checks or invent tokens to bypass a connection problem.

The connector does not expose deletion, user invitations, role changes, guard credential creation or billing. Disconnect it from the client and revoke its grant in PatrolTech when no longer needed.

[Privacy policy](https://patroltech.online/legal/privacy) | [Terms](https://patroltech.online/legal/terms) | Support: info@patroltech.app
