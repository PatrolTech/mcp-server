import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startMcpHarness, type McpHarness } from './testing/mcpHarness.js';
import { createTestIssuer, type TestIssuer } from './testing/oauthFixtures.js';

const ERAS = ['legacy', 'modern'] as const;

const PROMPTS = [
  'patroltech_review_missed_rounds',
  'patroltech_review_suspicious_scans',
  'patroltech_set_up_account',
  'patroltech_weekly_summary',
];

const GUIDES = ['patroltech://guides/choosing-a-tool', 'patroltech://guides/reading-the-data'];

const namedTools = (text: string) =>
  (text.match(/patroltech_[a-z0-9_]+/g) ?? []).filter((name) => !name.endsWith('_'));

let issuer: TestIssuer;
let harness: McpHarness | undefined;

beforeAll(async () => {
  issuer = await createTestIssuer();
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const promptText = async (
  client: Awaited<ReturnType<McpHarness['connect']>>,
  name: string,
  args?: Record<string, string>
) => {
  const { messages } = await client.getPrompt({ name, arguments: args });
  const [message] = messages;
  if (message.content.type !== 'text') throw new Error(`Prompt ${name} did not return text`);
  return message.content.text;
};

describe.each(ERAS)('prompts (%s era)', (era) => {
  it('lists the prompts, each with a title and a description', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    const { prompts } = await client.listPrompts();

    expect(prompts.map((p) => p.name).sort()).toEqual(PROMPTS);
    for (const prompt of prompts) {
      expect(prompt.title).toBeTruthy();
      expect(prompt.description).toBeTruthy();
    }
  });

  it('only names tools the server lists, and calls no backend', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);
    const { tools } = await client.listTools();

    for (const name of PROMPTS) {
      const named = namedTools(await promptText(client, name));
      expect(named.length, name).toBeGreaterThan(0);
      expect(named.filter((tool) => !tools.some((t) => t.name === tool))).toEqual([]);
    }
    expect(harness.backend.apiCalls()).toHaveLength(0);
  });

  it('passes the period given to the tools, and last_7_days without one', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    const given = await promptText(client, 'patroltech_review_suspicious_scans', {
      period: 'yesterday',
    });
    const missing = await promptText(client, 'patroltech_review_suspicious_scans');

    expect(given).toContain('period: yesterday');
    expect(missing).toContain('period: last_7_days');
  });

  it('refuses a period the tools do not take', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    await expect(
      client.getPrompt({
        name: 'patroltech_review_suspicious_scans',
        arguments: { period: 'last night' },
      })
    ).rejects.toThrow(/period/i);
  });

  it('asks the scan tools only for what they take', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);
    const { tools } = await client.listTools();
    const propertiesOf = (name: string) => {
      const tool = tools.find((t) => t.name === name);
      return tool?.inputSchema.properties as Record<string, { enum?: string[] }>;
    };
    const { prompts } = await client.listPrompts();
    const period = prompts
      .find((p) => p.name === 'patroltech_review_suspicious_scans')
      ?.arguments?.find((a) => a.name === 'period');

    expect(period?.required).toBeFalsy();
    const scans = propertiesOf('patroltech_scans_list_recent');
    expect(scans.suspiciousOnly).toBeDefined();
    expect(scans.invalidOnly).toBeDefined();
    for (const value of ['today', 'yesterday', 'last_7_days', 'last_30_days']) {
      expect(scans.period.enum).toContain(value);
      expect(propertiesOf('patroltech_scans_count_by_patroller').period.enum).toContain(value);
    }
  });

  it('the prompt of missed rounds takes no period, because its tools cannot honour one', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);
    const { prompts } = await client.listPrompts();
    const { tools } = await client.listTools();

    expect(
      prompts.find((p) => p.name === 'patroltech_review_missed_rounds')?.arguments ?? []
    ).toEqual([]);
    for (const name of ['patroltech_rounds_get_status', 'patroltech_rounds_list_by_route']) {
      const properties = tools.find((t) => t.name === name)?.inputSchema.properties ?? {};
      expect(Object.keys(properties)).not.toContain('period');
    }
    expect(await promptText(client, 'patroltech_review_missed_rounds')).toMatch(
      /only the most recent rounds/
    );
  });

  it('refuses a prompt that does not exist', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    await expect(client.getPrompt({ name: 'patroltech_nope' })).rejects.toThrow(/patroltech_nope/);
  });

  it('keeps the two-step rule and the care with people', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    const setUp = await promptText(client, 'patroltech_set_up_account');
    expect(setUp).toMatch(/patroltech_proposals_confirm only after I agree/);
    expect(setUp).toMatch(/creating a guard, tell me to do it in the PatrolTech dashboard/);
    expect(await promptText(client, 'patroltech_review_suspicious_scans')).toMatch(
      /not an assessment/
    );
  });
});

describe.each(ERAS)('resources (%s era)', (era) => {
  it('lists the guides as Markdown', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    const { resources } = await client.listResources();

    expect(resources.map((r) => r.uri).sort()).toEqual(GUIDES);
    for (const resource of resources) {
      expect(resource.mimeType).toBe('text/markdown');
      expect(resource.title).toBeTruthy();
      expect(resource.description).toBeTruthy();
    }
  });

  it('reads each guide, which only names tools the server lists, without a backend call', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);
    const { tools } = await client.listTools();

    for (const uri of GUIDES) {
      const { contents } = await client.readResource({ uri });
      const [content] = contents;
      if (!('text' in content)) throw new Error(`${uri} did not return text`);
      expect(content.uri).toBe(uri);
      expect(content.mimeType).toBe('text/markdown');
      const named = namedTools(content.text);
      expect(named.filter((tool) => !tools.some((t) => t.name === tool))).toEqual([]);
    }
    expect(harness.backend.apiCalls()).toHaveLength(0);
  });

  it('refuses a guide that does not exist', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    await expect(client.readResource({ uri: 'patroltech://guides/nope' })).rejects.toThrow(/nope/);
  });

  it('says which times are local and what the round statuses cover', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    const text = JSON.stringify(await client.readResource({ uri: GUIDES[1] }));

    expect(text).toMatch(/access logs, route schedules/);
    expect(text).toMatch(/patroltech_rounds_get_status/);
    expect(text).toMatch(/only the latest rounds of each route/);
  });
});
