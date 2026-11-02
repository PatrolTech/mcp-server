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
  if (message?.content.type !== 'text') throw new Error(`Prompt ${name} did not return text`);
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

  it('uses the period given, and the last 7 days without one', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    const given = await promptText(client, 'patroltech_review_missed_rounds', {
      period: 'last night',
    });
    const missing = await promptText(client, 'patroltech_review_missed_rounds');

    expect(given).toContain('last night');
    expect(missing).toContain('the last 7 days');
  });

  it('refuses a period over its limit', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    await expect(
      client.getPrompt({
        name: 'patroltech_review_missed_rounds',
        arguments: { period: 'x'.repeat(101) },
      })
    ).rejects.toThrow();
  });

  it('keeps the two-step rule and the care with people', async () => {
    harness = await startMcpHarness(issuer);
    const client = await harness.connect(era);

    expect(await promptText(client, 'patroltech_set_up_account')).toMatch(
      /patroltech_proposals_confirm only after I agree/
    );
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
      if (!content || !('text' in content)) throw new Error(`${uri} did not return text`);
      expect(content.uri).toBe(uri);
      expect(content.mimeType).toBe('text/markdown');
      const named = namedTools(content.text);
      expect(named.filter((tool) => !tools.some((t) => t.name === tool))).toEqual([]);
    }
    expect(harness.backend.apiCalls()).toHaveLength(0);
  });
});
