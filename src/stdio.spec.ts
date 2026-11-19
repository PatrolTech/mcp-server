import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, describe, expect, it } from 'vitest';

// Lo que hace Glama: arrancar `stdio.ts` sin configuración y listar por stdio.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', fileURLToPath(new URL('./stdio.ts', import.meta.url))],
  env: { PATH: process.env.PATH ?? '' },
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
    const accountContext = tools.find((t) => t.name === 'patroltech_account_get_context');
    expect(accountContext?.description).toContain('https://dashboard.patroltech.online');

    const result = await client.callTool({ name: 'patroltech_account_get_context', arguments: {} });
    expect(result.isError).toBe(true);
  }, 30_000);
});
