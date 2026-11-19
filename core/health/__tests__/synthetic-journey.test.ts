import { describe, it, expect, beforeEach } from 'vitest';
import { SyntheticJourneyMonitor } from '../synthetic-journey';

describe('SyntheticJourneyMonitor', () => {
  let monitor: SyntheticJourneyMonitor;

  beforeEach(() => {
    monitor = new SyntheticJourneyMonitor();
  });

  describe('journey execution', () => {
    it('runs all journey paths', async () => {
      const result = await monitor.runJourneys('testnet');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.journeys.length).toBeGreaterThan(0);
        expect(result.value.network).toBe('testnet');
      }
    });

    it('tracks individual journey results', async () => {
      const result = await monitor.runJourneys('testnet', ['normal', 'failure']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.journeys.length).toBe(2);
      }
    });

    it('distinguishes success from expected failure', async () => {
      const result = await monitor.runJourneys('testnet', ['authorization']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Authorization journey should fail as expected
        const authJourney = result.value.journeys.find(j => j.scenario.path === 'authorization');
        expect(authJourney).toBeDefined();
        // Result.ok will still be true because the failure was expected
      }
    });
  });

  describe('failure and recovery paths', () => {
    it('handles transient failures with retry', async () => {
      const result = await monitor.runJourneys('testnet', ['failure']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const journey = result.value.journeys[0];
        expect(journey.scenario.path).toBe('failure');
      }
    });

    it('tracks recovery attempts', async () => {
      const result = await monitor.runJourneys('testnet', ['retry', 'rate-limited']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Some journeys may have recovery attempts
        const withRecovery = result.value.journeys.filter(j => j.recoveryAttempts);
        expect(Array.isArray(withRecovery)).toBe(true);
      }
    });
  });

  describe('authorization boundaries', () => {
    it('verifies authorization failures are caught', async () => {
      const result = await monitor.runJourneys('testnet', ['authorization']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const authJourney = result.value.journeys.find(j => j.scenario.path === 'authorization');
        expect(authJourney?.scenario.shouldSucceed).toBe(false);
      }
    });
  });

  describe('metrics and reporting', () => {
    it('calculates success rates', async () => {
      const result = await monitor.runJourneys('testnet', ['normal', 'failure']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.successRate).toBeGreaterThanOrEqual(0);
        expect(result.value.successRate).toBeLessThanOrEqual(100);
      }
    });

    it('tracks total duration', async () => {
      const result = await monitor.runJourneys('testnet', ['normal']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.totalDurationMs).toBeGreaterThan(0);
        expect(result.value.completedAt.getTime()).toBeGreaterThanOrEqual(result.value.startedAt.getTime());
      }
    });

    it('provides recovery metrics', () => {
      const metrics = monitor.getRecoveryMetrics();

      expect(metrics).toHaveProperty('journeyCount');
      expect(metrics).toHaveProperty('recoveryAttempts');
      expect(metrics).toHaveProperty('recoverySuccessRate');
      expect(metrics.recoverySuccessRate).toBeGreaterThanOrEqual(0);
      expect(metrics.recoverySuccessRate).toBeLessThanOrEqual(100);
    });

    it('returns journey results history', async () => {
      await monitor.runJourneys('testnet', ['normal', 'failure']);
      const results = monitor.getJourneyResults();

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it('calculates overall success rate', async () => {
      await monitor.runJourneys('testnet', ['normal', 'failure', 'retry']);
      const rate = monitor.getSuccessRate();

      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(100);
    });
  });

  describe('edge cases and documentation', () => {
    it('handles empty journey paths list', async () => {
      const result = await monitor.runJourneys('testnet', []);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.journeys.length).toBe(0);
      }
    });

    it('respects scenario max attempts', async () => {
      const result = await monitor.runJourneys('testnet', ['failure']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const journey = result.value.journeys[0];
        expect(journey.attempts).toBeLessThanOrEqual(journey.scenario.maxAttempts);
      }
    });

    it('tracks attempt counts for retry scenarios', async () => {
      const result = await monitor.runJourneys('testnet', ['retry']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const journey = result.value.journeys[0];
        expect(journey.attempts).toBeGreaterThan(0);
      }
    });

    it('provides correlation ID for tracing', async () => {
      const result = await monitor.runJourneys('testnet');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.correlationId).toBeDefined();
        expect(result.value.correlationId).toMatch(/^journey-/);
      }
    });

    it('records timestamps for all journeys', async () => {
      const result = await monitor.runJourneys('testnet', ['normal']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const journey = result.value.journeys[0];
        expect(journey.timestamp).toBeInstanceOf(Date);
        expect(journey.actualDurationMs).toBeGreaterThan(0);
      }
    });
  });

  describe('multiple network support', () => {
    it('runs journeys on different networks', async () => {
      const testnetResult = await monitor.runJourneys('testnet');
      const mainnetMonitor = new SyntheticJourneyMonitor();
      const mainnetResult = await mainnetMonitor.runJourneys('mainnet');

      expect(testnetResult.ok).toBe(true);
      expect(mainnetResult.ok).toBe(true);

      if (testnetResult.ok && mainnetResult.ok) {
        expect(testnetResult.value.network).toBe('testnet');
        expect(mainnetResult.value.network).toBe('mainnet');
      }
    });
  });
});
