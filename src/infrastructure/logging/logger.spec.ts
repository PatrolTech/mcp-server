import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';

function captureStreams() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

const base = { service: 'mcp-server', env: 'production', version: '0.1.0' } as const;

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one JSON line per entry to stdout with the base fields and meta', () => {
    const { out } = captureStreams();

    createLogger({ ...base, level: 'info' }).info('mcp.started', { port: 3110 });

    expect(out).toHaveLength(1);
    expect(out[0]?.endsWith('\n')).toBe(true);
    const entry = JSON.parse(out[0] ?? '') as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'info',
      message: 'mcp.started',
      service: 'mcp-server',
      env: 'production',
      version: '0.1.0',
      port: 3110,
    });
    expect(typeof entry.timestamp).toBe('string');
  });

  it('writes warn and error to stderr', () => {
    const { out, err } = captureStreams();
    const logger = createLogger({ ...base, level: 'info' });

    logger.warn('careful');
    logger.error('boom');

    expect(out).toHaveLength(0);
    expect(err.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
      'warn',
      'error',
    ]);
  });

  it('serializes meta.err as name and message, without the stack in production', () => {
    const { err } = captureStreams();

    createLogger({ ...base, level: 'info' }).error('failed', { err: new TypeError('bad input') });

    const entry = JSON.parse(err[0] ?? '') as { err: Record<string, unknown> };
    expect(entry.err).toEqual({ name: 'TypeError', message: 'bad input' });
  });

  it('includes the stack outside production', () => {
    const { err } = captureStreams();

    createLogger({ ...base, env: 'development', level: 'info' }).error('failed', {
      err: new Error('x'),
    });

    const entry = JSON.parse(err[0] ?? '') as { err: { stack?: string } };
    expect(entry.err.stack).toContain('Error: x');
  });

  it('drops entries below the configured level', () => {
    const { out, err } = captureStreams();
    const logger = createLogger({ ...base, level: 'error' });

    logger.info('quiet');
    logger.warn('quiet');
    logger.error('loud');

    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
  });

  it('writes `always` entries to stdout whatever the level (audit and heartbeat)', () => {
    const { out, err } = captureStreams();
    const logger = createLogger({ ...base, level: 'error' });

    logger.always('mcp.tool_call', { event: 'mcp.tool_call', tool: 't' });
    logger.info('quiet');

    expect(err).toHaveLength(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      level: 'info',
      message: 'mcp.tool_call',
      event: 'mcp.tool_call',
      service: 'mcp-server',
      tool: 't',
    });
  });

  it('does not let meta override the base fields', () => {
    const { out } = captureStreams();

    createLogger({ ...base, level: 'info' }).info('x', { service: 'evil', level: 'error' });

    const entry = JSON.parse(out[0] ?? '') as Record<string, unknown>;
    expect(entry.service).toBe('mcp-server');
    expect(entry.level).toBe('info');
  });

  it('never throws when meta cannot be serialized, and still writes a minimal line', () => {
    const { err } = captureStreams();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const logger = createLogger({ ...base, level: 'info' });
    expect(() => {
      logger.error('cyclic', circular);
      logger.error('bigint', { count: 10n });
    }).not.toThrow();

    expect(err).toHaveLength(2);
    const entry = JSON.parse(err[0] ?? '') as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'error',
      message: 'cyclic',
      service: 'mcp-server',
      serializationError: true,
    });
  });
});
