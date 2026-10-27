import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { PatrolTechApiError, type Logger } from '@patroltech/agent-capabilities';
import { describe, expect, it, vi } from 'vitest';
import type { McpCallIdentity } from './mcpRequest.js';
import type { UserSessionContext } from '../../application/session/sessionContext.js';
import type { ToolCallRecord } from '../../application/ports/AuditTrail.js';
import type {
  BackendCallReport,
  BackendCallTracker,
} from '../../application/ports/BackendCallTracker.js';
import {
  READ_ONLY_ANNOTATIONS,
  READ_RATE_LIMIT,
  WRITE_RATE_LIMIT,
  registerCapabilityTool,
  type CapabilityToolRun,
  type ToolBinding,
} from './registerCapabilityTool.js';

const ACCESS_TOKEN = 'access-token-secret';
const AGENT_TOKEN = 'agent-session-secret';
const NO_CHANGES = /No changes have been made/;

const identity: McpCallIdentity = {
  accessToken: ACCESS_TOKEN,
  clientId: 'client-1',
  userId: 'user-1',
  requestId: 'req-1',
  agentSession: {
    token: AGENT_TOKEN,
    expiresAt: 0,
    scopes: ['read', 'write'],
    userId: 'user-1',
    roles: { organizationRoles: {}, orgWideRoles: {}, locationRoles: {} },
  },
};

const session: UserSessionContext = {
  organizations: [],
  token: AGENT_TOKEN,
  tz: 'Europe/Madrid',
  country: null,
  language: 'en',
};

/** Ejecuta el cuerpo y devuelve el informe de backend que el test quiera simular. */
function trackerReporting(report: Partial<BackendCallReport>): BackendCallTracker {
  return {
    async track(_labels, body) {
      try {
        return {
          settled: { status: 'fulfilled', value: await body() },
          report: { sessionRejected: false, unreachable: false, ...report },
        };
      } catch (reason) {
        return {
          settled: { status: 'rejected', reason },
          report: { sessionRejected: false, unreachable: false, ...report },
        };
      }
    },
    acknowledge: () => undefined,
  };
}

interface Setup {
  run: CapabilityToolRun;
  report?: Partial<BackendCallReport>;
  requiredScope?: 'write';
  operation?: 'read' | 'write';
}

async function callOnce({ run, report = {}, requiredScope, operation = 'read' }: Setup) {
  const audit: ToolCallRecord[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
  const binding: ToolBinding = {
    runtime: {
      rateLimiter: { consume: () => Promise.resolve({ allowed: true, retryAfterSec: 0 }) },
      audit: { toolCall: (record) => audit.push(record) },
      tracker: trackerReporting(report),
      sessions: { forget: vi.fn() },
      directory: {
        organizationNames: () => Promise.resolve(new Map()),
        preferences: () => Promise.resolve({ language: null, timezone: null }),
      },
      urls: {},
      logger,
    },
    identity,
    loadSession: () => Promise.resolve(session),
  };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerCapabilityTool(
    server,
    binding,
    {
      name: 'patroltech_test_tool',
      title: 'Test',
      description: 'Test tool.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      operation,
      rateLimit: requiredScope ? WRITE_RATE_LIMIT : READ_RATE_LIMIT,
      ...(requiredScope ? { requiredScope } : {}),
    },
    run
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'c', version: '0.0.0' });
  await client.connect(clientTransport);
  const result = (await client.callTool({ name: 'patroltech_test_tool', arguments: {} })) as {
    isError?: boolean;
    content: { text?: string }[];
  };
  await client.close();
  await server.close();
  return { text: result.content[0]?.text ?? '', isError: result.isError, audit, logger };
}

describe('registerCapabilityTool failure classification (by the error, not the call report)', () => {
  it('an unrelated bug after a swallowed backend 403 is `internal`, with the neutral text', async () => {
    const { text, isError, audit } = await callOnce({
      report: { failedStatus: 403 },
      run: async (_args, call) => {
        await call.session();
        throw new TypeError("Cannot read properties of undefined (reading 'name')");
      },
    });

    expect(isError).toBe(true);
    expect(text).toMatch(/internal error/);
    expect(text).not.toMatch(/dashboard isn't responding/);
    expect(audit[0]).toMatchObject({ outcome: 'error', errorKind: 'internal' });
  });

  it('a backend rejection is `backend_<status>` and a read says nothing about changes', async () => {
    const { text, audit } = await callOnce({
      run: async (_args, call) => {
        await call.session();
        throw new PatrolTechApiError(500, '/api/x', {});
      },
    });

    expect(text).toMatch(/isn't responding/);
    expect(text).not.toMatch(NO_CHANGES);
    expect(audit[0]).toMatchObject({ errorKind: 'backend_500' });
  });

  it('a write keeps the action wording ("no changes have been made")', async () => {
    const { text } = await callOnce({
      requiredScope: 'write',
      operation: 'write',
      run: async (_args, call) => {
        await call.session();
        throw new PatrolTechApiError(500, '/api/x', {});
      },
    });
    expect(text).toMatch(NO_CHANGES);
  });

  it('picks the wording by the declared operation, not by the scope (a write-scope read)', async () => {
    const { text } = await callOnce({
      requiredScope: 'write',
      operation: 'read',
      run: async (_args, call) => {
        await call.session();
        throw new PatrolTechApiError(500, '/api/x', {});
      },
    });
    expect(text).toMatch(/isn't responding/);
    expect(text).not.toMatch(NO_CHANGES);
  });

  it.each([
    ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
    ['an abort', new DOMException('aborted', 'AbortError')],
    ['a network failure', new TypeError('fetch failed')],
  ])('%s is `backend_unreachable`, with the translated text', async (_case, error) => {
    const { text, audit } = await callOnce({
      run: async (_args, call) => {
        await call.session();
        throw error;
      },
    });
    expect(text).toMatch(/isn't responding/);
    expect(audit[0]).toMatchObject({ errorKind: 'backend_unreachable' });
  });
});

describe('registerCapabilityTool internal-failure log', () => {
  it('logs the message and stack with the tokens redacted, and none of it reaches the model', async () => {
    const { text, logger } = await callOnce({
      run: () => Promise.reject(new Error(`boom with ${AGENT_TOKEN} and ${ACCESS_TOKEN}`)),
    });

    expect(logger.error).toHaveBeenCalledWith(
      'mcp.tool_failed',
      expect.objectContaining({
        tool: 'patroltech_test_tool',
        errorKind: 'internal',
        errorName: 'Error',
        errorMessage: 'boom with [redacted] and [redacted]',
        stack: expect.stringContaining('boom with [redacted]') as string,
        requestId: 'req-1',
      })
    );
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain(AGENT_TOKEN);
    expect(logged).not.toContain(ACCESS_TOKEN);
    expect(text).not.toMatch(/boom|redacted/);
  });
});
