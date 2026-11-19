import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, describe, expect, it } from 'vitest';

// Lo que hace Glama: arrancar `stdio.ts` con valores de relleno y listar por stdio.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', fileURLToPath(new URL('./stdio.ts', import.meta.url))],
  env: {
    PATH: process.env.PATH ?? '',
    API_BASE_URL: 'https://api.example.com',
    APP_BASE_URL: 'https://app.example.com',
    APP_ENVIRONMENT: 'development',
    DASHBOARD_URL: 'https://dashboard.example.com',
    MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    OAUTH_ISSUER: 'https://auth.example.com',
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'stdio-check', version: '1.0.0' });
let stderr = '';
transport.stderr?.on('data', (chunk: Buffer) => {
  stderr += chunk.toString();
});

afterAll(async () => {
  await client.close();
});

describe('stdio entry', () => {
  it('lists the same tools as the HTTP endpoint without a token, and refuses to run them', async () => {
    await client.connect(transport).catch((error: unknown) => {
      throw new Error(`stdio.ts did not start: ${String(error)}\n${stderr}`);
    });

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(30);
    expect(tools.map((t) => t.name)).toContain('patroltech_account_get_context');

    const result = await client.callTool({ name: 'patroltech_account_get_context', arguments: {} });
    expect(result.isError).toBe(true);
  }, 30_000);
});
