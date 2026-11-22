import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { OpenHabClient } from '../openhab-client.js';

describe('OpenHabClient Logs', () => {
  let client: OpenHabClient;
  let mock: MockAdapter;
  const baseUrl = 'http://openhab:8080';
  const apiToken = 'fake-token';

  beforeEach(() => {
    mock = new MockAdapter(axios as ConstructorParameters<typeof MockAdapter>[0]);
    // We need to trigger the SSE handler manually to fill the buffer
    client = new OpenHabClient(baseUrl, apiToken, { enableSSE: true });
  });

  afterEach(() => {
    mock.restore();
  });

  it('should buffer events and retrieve logs', async () => {
    // Access private buffer for testing purposes
    const clientAny = client as unknown as {
      addLogToBuffer: (log: string) => void;
      getHistoricalLogs: (n: number, search?: string) => Promise<string[]>;
    };

    // Populate buffer
    for (let i = 0; i < 50; i++) {
      clientAny.addLogToBuffer(`Log entry ${i}`);
    }

    const recent = await client.getRecentLogs(20);
    expect(recent).toHaveLength(20);
    expect(recent[19]).toBe('Log entry 49');

    const historical = await (
      client as unknown as { getHistoricalLogs: (n: number) => Promise<string[]> }
    ).getHistoricalLogs(50);
    expect(historical).toHaveLength(50);
    expect(historical[0]).toBe('Log entry 0');
  });

  it('should filter logs by search query', async () => {
    const clientAny = client as unknown as {
      addLogToBuffer: (log: string) => void;
      getHistoricalLogs: (n: number, search?: string) => Promise<string[]>;
    };
    clientAny.addLogToBuffer('Critical Error: system failed');
    clientAny.addLogToBuffer('Info: system starting');
    clientAny.addLogToBuffer('Warning: high memory');

    const filtered = await (
      client as unknown as { getHistoricalLogs: (n: number, s: string) => Promise<string[]> }
    ).getHistoricalLogs(10, 'Critical');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toContain('Critical Error');
  });

  it('should return no logs for zero or negative limits', async () => {
    const clientAny = client as unknown as {
      addLogToBuffer: (log: string) => void;
    };
    clientAny.addLogToBuffer('Log entry');

    await expect(client.getRecentLogs(0)).resolves.toEqual([]);
    await expect(client.getRecentLogs(-1)).resolves.toEqual([]);
    await expect(client.getHistoricalLogs(0)).resolves.toEqual([]);
    await expect(client.getHistoricalLogs(-1)).resolves.toEqual([]);
  });

  it('should respect the log buffer limits', async () => {
    const clientAny = client as unknown as {
      addLogToBuffer: (log: string) => void;
      getHistoricalLogs: (n: number) => Promise<string[]>;
    };
    for (let i = 0; i < 6000; i++) {
      clientAny.addLogToBuffer(`Log ${i}`);
    }

    const historical = await (
      client as unknown as { getHistoricalLogs: (n: number) => Promise<string[]> }
    ).getHistoricalLogs(6000);
    expect(historical).toHaveLength(5000); // Should be capped at MAX_LOG_BUFFER
    expect(historical[0]).toBe('Log 1000');
  });
});
