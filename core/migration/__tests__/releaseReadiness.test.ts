import { describe, expect, it } from 'vitest';
import {
  MigrationReleaseReadinessVerifier,
  type MigrationReleaseConfig,
  type ReadinessActor,
  type ReadinessProbe
} from '../release-readiness';
import type { MigrationDefinition } from '../types';

interface TestRecord {
  id: string;
  version: number;
}

describe('Release Readiness Checks for Migrations and Rollback Evidence (#322)', () => {
  const maintainerActor: ReadinessActor = {
    role: 'maintainer',
    userId: 'usr_maint_1'
  };

  const sampleMigration: MigrationDefinition<TestRecord, TestRecord> = {
    id: '20261021_utix_order_state_v3',
    name: 'Add ledger timestamp and cancellation window to orders',
    description: 'Upgrades order state schema from version 2 to version 3',
    fromVersion: 2,
    toVersion: 3,
    riskLevel: 'medium',
    rollbackNotes: 'Restore orders table from snapshot snap_orders_v2; replay events from journal',
    forwardFixNotes: 'Apply patch migration 20261021_patch_null_timestamps to backfill zeros',
    dryRun: (records) => ({
      migrationId: '20261021_utix_order_state_v3',
      targetVersion: 3,
      totalRecords: records.length,
      affectedCount: records.length,
      unchangedCount: 0,
      sampleDiffs: [],
      riskLevel: 'medium',
      rollbackNotes: 'Restore orders table from snapshot snap_orders_v2',
      forwardFixNotes: 'Apply patch migration',
      estimatedDurationMs: 120
    }),
    apply: async (records) => records.map((r) => ({ ...r, version: 3 }))
  };

  describe('Normal Path', () => {
    it('evaluates fully compliant migration plan and approves release', async () => {
      const config: MigrationReleaseConfig<TestRecord, TestRecord> = {
        releaseId: 'rel_2026_10_21_v3',
        targetVersion: 3,
        migrations: [sampleMigration],
        snapshotId: 'snap_v2_final',
        snapshotData: { recordCount: 1500, state: 'consistent' }
      };

      const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(config, maintainerActor);

      expect(report.ready).toBe(true);
      expect(report.status).toBe('APPROVED');
      expect(report.discrepancies).toBeUndefined();
      expect(report.rollbackEvidence).toHaveLength(1);

      const evidence = report.rollbackEvidence[0];
      expect(evidence.migrationId).toBe('20261021_utix_order_state_v3');
      expect(evidence.fromVersion).toBe(2);
      expect(evidence.toVersion).toBe(3);
      expect(evidence.rollbackScriptHash).toHaveLength(64);
      expect(evidence.snapshotChecksum).toHaveLength(64);
      expect(evidence.verifiedBy).toBe('usr_maint_1');
    });
  });

  describe('Authorization Path', () => {
    it('rejects unauthorized contributor role', async () => {
      const unauthorizedActor: ReadinessActor = {
        role: 'contributor',
        userId: 'usr_contrib_2'
      };

      const config: MigrationReleaseConfig<TestRecord, TestRecord> = {
        releaseId: 'rel_2026_10_21_v3',
        targetVersion: 3,
        migrations: [sampleMigration]
      };

      const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(config, unauthorizedActor);

      expect(report.ready).toBe(false);
      expect(report.status).toBe('UNAUTHORIZED');
      expect(report.discrepancies).toBeDefined();
      expect(report.discrepancies?.[0]).toContain('Unauthorized');
      expect(report.rollbackEvidence).toHaveLength(0);
    });

    it('approves release_manager role', async () => {
      const releaseManagerActor: ReadinessActor = {
        role: 'release_manager',
        userId: 'usr_relmgr_9'
      };

      const config: MigrationReleaseConfig<TestRecord, TestRecord> = {
        releaseId: 'rel_2026_10_21_v3',
        targetVersion: 3,
        migrations: [sampleMigration]
      };

      const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(config, releaseManagerActor);
      expect(report.ready).toBe(true);
      expect(report.status).toBe('APPROVED');
    });
  });

  describe('Failure Path', () => {
    it('flags migration missing documented rollback procedure', async () => {
      const deficientMigration: MigrationDefinition<TestRecord, TestRecord> = {
        ...sampleMigration,
        id: '20261021_deficient',
        rollbackNotes: '', // Missing rollback notes
        forwardFixNotes: 'some notes here'
      };

      const config: MigrationReleaseConfig<TestRecord, TestRecord> = {
        releaseId: 'rel_deficient_test',
        targetVersion: 3,
        migrations: [deficientMigration]
      };

      const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(config, maintainerActor);

      expect(report.ready).toBe(false);
      expect(report.status).toBe('REJECTED');
      expect(report.discrepancies).toBeDefined();
      expect(report.discrepancies?.some((d) => d.includes('documented rollback procedure'))).toBe(true);
    });

    it('blocks critical risk migration without explicit allowCriticalRisk flag', async () => {
      const criticalMigration: MigrationDefinition<TestRecord, TestRecord> = {
        ...sampleMigration,
        id: '20261021_drop_table_v3',
        riskLevel: 'critical'
      };

      const config: MigrationReleaseConfig<TestRecord, TestRecord> = {
        releaseId: 'rel_critical_test',
        targetVersion: 3,
        migrations: [criticalMigration],
        allowCriticalRisk: false
      };

      const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(config, maintainerActor);

      expect(report.ready).toBe(false);
      expect(report.status).toBe('REJECTED');
      expect(report.discrepancies?.some((d) => d.includes('Critical risk migration'))).toBe(true);
    });

    it('rejects empty migration plan', async () => {
      const emptyConfig: MigrationReleaseConfig<TestRecord, TestRecord> = {
        releaseId: 'rel_empty_test',
        targetVersion: 1,
        migrations: []
      };

      const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(emptyConfig, maintainerActor);
      expect(report.ready).toBe(false);
      expect(report.status).toBe('REJECTED');
      expect(report.discrepancies?.some((d) => d.includes('no migration definitions'))).toBe(true);
    });
  });

  describe('Retry Path', () => {
    it('recovers from transient probe failure through retry with backoff', async () => {
      let callCount = 0;
      const transientProbe: ReadinessProbe = {
        name: 'remote_cluster_snapshot_probe',
        retryable: true,
        check: () => {
          callCount++;
          // Fails on first call, succeeds on second
          return callCount >= 2;
        }
      };

      const config: MigrationReleaseConfig<TestRecord, TestRecord> = {
        releaseId: 'rel_retry_test',
        targetVersion: 3,
        migrations: [sampleMigration],
        probes: [transientProbe],
        maxRetries: 3,
        initialBackoffMs: 5
      };

      const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(config, maintainerActor);

      expect(report.ready).toBe(true);
      expect(report.status).toBe('APPROVED');
      const probeCheck = report.checks.find((c) => c.checkName === 'remote_cluster_snapshot_probe');
      expect(probeCheck?.passed).toBe(true);
      expect(probeCheck?.attempts).toBe(2);
    });

    it('records failure when retries are exhausted on persistent probe error', async () => {
      let callCount = 0;
      const failingProbe: ReadinessProbe = {
        name: 'storage_health_probe',
        retryable: true,
        check: () => {
          callCount++;
          throw new Error('Connection refused to storage cluster');
        }
      };

      const config: MigrationReleaseConfig<TestRecord, TestRecord> = {
        releaseId: 'rel_fail_retry_test',
        targetVersion: 3,
        migrations: [sampleMigration],
        probes: [failingProbe],
        maxRetries: 3,
        initialBackoffMs: 5
      };

      const report = await MigrationReleaseReadinessVerifier.evaluateReadiness(config, maintainerActor);

      expect(report.ready).toBe(false);
      expect(report.status).toBe('REJECTED');
      expect(callCount).toBe(3);
      expect(report.discrepancies?.some((d) => d.includes('storage_health_probe'))).toBe(true);
    });
  });

  describe('Rollback Evidence Integrity', () => {
    it('produces deterministic cryptographic digests for identical migration parameters', () => {
      const evidence1 = MigrationReleaseReadinessVerifier.generateRollbackEvidence(
        sampleMigration,
        'snapshot_static_id',
        { tables: ['orders', 'users'] }
      );

      const evidence2 = MigrationReleaseReadinessVerifier.generateRollbackEvidence(
        sampleMigration,
        'snapshot_static_id',
        { tables: ['orders', 'users'] }
      );

      expect(evidence1.rollbackScriptHash).toBe(evidence2.rollbackScriptHash);
      expect(evidence1.snapshotChecksum).toBe(evidence2.snapshotChecksum);
    });
  });
});
