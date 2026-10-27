import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_INTERVAL_MS, startHeartbeat } from './heartbeat.js';
import { createLogger } from './logger.js';

describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes one `mcp.heartbeat` line per interval even with LOG_LEVEL=error, until stopped', () => {
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

    const stop = startHeartbeat(logger);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);

    const beats = out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(beats).toHaveLength(2);
    expect(beats[0]).toMatchObject({
      message: 'mcp.heartbeat',
      event: 'mcp.heartbeat',
      pid: process.pid,
    });
    expect(typeof beats[0]?.uptimeSec).toBe('number');
  });
});
