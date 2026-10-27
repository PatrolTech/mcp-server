import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type ServiceLogger } from '../logging/logger.js';
import { LoggerAuditTrail, argsHash, canonicalJson } from './LoggerAuditTrail.js';

const spyLogger = (): ServiceLogger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  always: vi.fn(),
});

describe('canonicalJson / argsHash', () => {
  it('serialises objects with sorted keys at every level, so equal args hash equally', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}'
    );
    expect(argsHash({ b: 1, a: 2 })).toBe(argsHash({ a: 2, b: 1 }));
    expect(argsHash({ a: 2, b: 1 })).toBe(
      createHash('sha256').update('{"a":2,"b":1}').digest('hex')
    );
  });

  it('drops undefined values like JSON does', () => {
    expect(canonicalJson({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
  });
});

describe('LoggerAuditTrail', () => {
  it('logs one `mcp.tool_call` line with the args hash and never the raw args', () => {
    const logger = spyLogger();
    const audit = new LoggerAuditTrail(logger);

    audit.toolCall({
      userId: 'user-1',
      clientId: 'client-1',
      organizationId: 'org-a',
      tool: 'patroltech_incidents_get',
      args: { incidencia: 'secreto del usuario' },
      outcome: 'error',
      errorKind: 'backend_500',
      durationMs: 12.7,
      requestId: 'req-1',
    });

    expect(logger.always).toHaveBeenCalledWith('mcp.tool_call', {
      event: 'mcp.tool_call',
      userId: 'user-1',
      clientId: 'client-1',
      organizationId: 'org-a',
      tool: 'patroltech_incidents_get',
      argsHash: argsHash({ incidencia: 'secreto del usuario' }),
      outcome: 'error',
      errorKind: 'backend_500',
      durationMs: 13,
      requestId: 'req-1',
    });
    expect(JSON.stringify(vi.mocked(logger.always).mock.calls)).not.toContain('secreto');
  });

  it('omits organizationId and errorKind when there are none', () => {
    const logger = spyLogger();
    new LoggerAuditTrail(logger).toolCall({
      userId: 'u',
      clientId: 'c',
      tool: 't',
      args: {},
      outcome: 'ok',
      durationMs: 1,
      requestId: 'r',
    });
    const meta = vi.mocked(logger.always).mock.calls[0][1] ?? {};
    expect(meta).not.toHaveProperty('organizationId');
    expect(meta).not.toHaveProperty('errorKind');
  });

  it('is written even with LOG_LEVEL=error (the audit is a security requirement)', () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const logger = createLogger({
      service: 'mcp-server',
      env: 'production',
      version: '0.1.0',
      level: 'error',
    });

    new LoggerAuditTrail(logger).toolCall({
      userId: 'u',
      clientId: 'c',
      tool: 't',
      args: {},
      outcome: 'ok',
      durationMs: 1,
      requestId: 'r',
    });

    expect(out.map((line) => (JSON.parse(line) as { event?: string }).event)).toEqual([
      'mcp.tool_call',
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
