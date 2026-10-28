import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startMcpHarness, type McpHarness } from './testing/mcpHarness.js';
import { createTestIssuer, type TestIssuer } from './testing/oauthFixtures.js';

const ERAS = ['legacy', 'modern'] as const;

let issuer: TestIssuer;
let harness: McpHarness | undefined;

beforeAll(async () => {
  issuer = await createTestIssuer();
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe.each(ERAS)('server instructions (%s era)', (era) => {
  it('guides comparisons of guards to the ranking tools and their careful presentation', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);
    const instructions = client.getInstructions() ?? '';

    expect(instructions).toMatch(/patroltech_patrollers_get_ranking/);
    expect(instructions).toMatch(/patroltech_scans_count_by_patroller/);
    expect(instructions).toMatch(/instead of building/i);
    expect(instructions).toMatch(/activity data .*not an assessment/i);
    expect(instructions).toMatch(/employment/i);
  });

  it('says where the user reviews this connection and never to reveal tokens', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);
    const instructions = client.getInstructions() ?? '';

    expect(instructions).toMatch(/Connected apps/);
    expect(instructions).toMatch(/never reveal .*tokens/i);
  });

  it('only names tools that the server lists, and needs no backend call', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);
    const { tools } = await client.listTools();
    const named = (client.getInstructions() ?? '').match(/patroltech_[a-z0-9_]+/g) ?? [];

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !tools.some((t) => t.name === name))).toEqual([]);
    expect(harness.backend.apiCalls()).toHaveLength(0);
  });
});

describe.each(ERAS)('how to review this connection (%s era)', (era) => {
  it('the account context tool, which every client lists, says where: Connected apps in the dashboard of the config', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);
    const { tools } = await client.listTools();
    const context = tools.find((t) => t.name === 'patroltech_account_get_context');

    expect(context?.description).toContain('https://dashboard.example.test');
    expect(context?.description).toMatch(/Connected apps/);
    expect(context?.description).toMatch(/Aplicaciones conectadas/);
    expect(context?.description).toMatch(/review or disconnect/i);
    // Solo ahí: no se repite en el resto de herramientas.
    const others = tools.filter(
      (t) => t.name !== context?.name && (t.description ?? '').includes('Connected apps')
    );
    expect(others.map((t) => t.name)).toEqual([]);
  });
});
