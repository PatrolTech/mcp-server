import { buildCatalog, noopLogger, type PatrolTechGateway } from '@patroltech/agent-capabilities';
import { describe, expect, it } from 'vitest';
import { MAX_TOOL_NAME_LENGTH, toolNameFor } from './toolNaming.js';

describe('toolNameFor', () => {
  it('prefixes `patroltech_` and turns the dots of the catalog id into underscores', () => {
    expect(toolNameFor('rounds.get_status')).toBe('patroltech_rounds_get_status');
  });

  it('rejects ids that would not make a valid tool name', () => {
    expect(() => toolNameFor('Bad Id')).toThrow();
    expect(() => toolNameFor(`a.${'b'.repeat(70)}`)).toThrow(/64/);
  });

  it('keeps every MCP catalog id within 64 characters', () => {
    const catalog = buildCatalog(
      { gateway: {} as PatrolTechGateway, logger: noopLogger, offerFiles: false },
      { channel: 'mcp' }
    );
    const ids = [...catalog.reads, ...catalog.actions].map(({ meta }) => meta.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(toolNameFor(id).length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    }
    expect(MAX_TOOL_NAME_LENGTH).toBe(64);
  });
});
