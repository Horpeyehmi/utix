import { err, ok, type Result } from '@/core/result/result';
import type {
  SessionErrorCode,
  RevocationReport,
  SecurityEvent,
  CrossDeviceSession,
} from './types';
import { sessionManager } from './manager';

export interface RevocationError {
  code: SessionErrorCode;
  message: string;
  retryable: boolean;
  timestamp: Date;
}

export interface RevocationOptions {
  maxRetries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export interface StaleSessionPruneReport extends RevocationReport {
  readonly pruneIntervalMs: number;
  readonly staleSessions: number;
  readonly staleDevices: number;
}

export class RevocationHandler {
  private revocationInProgress = new Map<string, Promise<RevocationReport>>();
  private lastPruneTime: Map<string, Date> = new Map();
  private revocationErrors: RevocationError[] = [];

  constructor(private options: RevocationOptions = {}) {}

  async revokeSessionAsync(
    sessionId: string,
    event: SecurityEvent,
    opts?: RevocationOptions
  ): Promise<Result<RevocationReport, SessionErrorCode>> {
    // Check if revocation is already in progress
    const existing = this.revocationInProgress.get(sessionId);
    if (existing) {
      try {
        const report = await existing;
        return ok(report);
      } catch (error) {
        return err('revocation_failed');
      }
    }

    const promise = this.performRevocation(sessionId, event, opts);
    this.revocationInProgress.set(sessionId, promise);

    try {
      const report = await promise;
      return ok(report);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? (error.code as SessionErrorCode) : 'revocation_failed';
      return err(code);
    } finally {
      this.revocationInProgress.delete(sessionId);
    }
  }

  async revokeAllUserSessionsAsync(
    userId: string,
    event: SecurityEvent,
    exceptDeviceId?: string,
    opts?: RevocationOptions
  ): Promise<Result<RevocationReport, SessionErrorCode>> {
    const options = { ...this.options, ...opts };
    const maxRetries = options.maxRetries ?? 3;
    let lastError: SessionErrorCode = 'revocation_failed';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = sessionManager.revokeAllUserSessions(userId, event, exceptDeviceId);
        if (result.ok) {
          this.recordSuccess(userId);
          return result;
        }
        lastError = result.error;

        if (attempt < maxRetries) {
          const delay = this.exponentialBackoff(attempt, options.backoffMs ?? 100);
          await this.sleep(delay);
        }
      } catch (error) {
        lastError = 'revocation_failed';
        if (attempt < maxRetries) {
          const delay = this.exponentialBackoff(attempt, options.backoffMs ?? 100);
          await this.sleep(delay);
        }
      }
    }

    this.recordError({
      code: lastError,
      message: `Failed to revoke all sessions for user ${userId} after ${maxRetries + 1} attempts`,
      retryable: true,
      timestamp: new Date(),
    });

    return err(lastError);
  }

  async pruneStaleSessions(
    staleThresholdMs: number = 30 * 24 * 60 * 60 * 1000,
    minIntervalMs: number = 60 * 60 * 1000
  ): Promise<Result<StaleSessionPruneReport, SessionErrorCode>> {
    const now = new Date();
    const lastPrune = this.lastPruneTime.get('global');

    // Avoid pruning too frequently
    if (lastPrune && now.getTime() - lastPrune.getTime() < minIntervalMs) {
      return err('revocation_failed');
    }

    try {
      const baseResult = sessionManager.pruneStaleSessions({
        staleThresholdMs,
        actor: { id: 'system', role: 'system' },
        now,
      });

      if (!baseResult.ok) {
        return baseResult;
      }

      const baseReport = baseResult.value;
      const pruneReport: StaleSessionPruneReport = {
        ...baseReport,
        pruneIntervalMs: minIntervalMs,
        staleSessions: baseReport.revokedSessionIds.length,
        staleDevices: baseReport.revokedDeviceIds.length,
      };

      this.lastPruneTime.set('global', now);
      return ok(pruneReport);
    } catch (error) {
      this.recordError({
        code: 'revocation_failed',
        message: `Failed to prune stale sessions: ${error instanceof Error ? error.message : 'unknown error'}`,
        retryable: true,
        timestamp: new Date(),
      });
      return err('revocation_failed');
    }
  }

  private async performRevocation(
    sessionId: string,
    event: SecurityEvent,
    opts?: RevocationOptions
  ): Promise<RevocationReport> {
    const options = { ...this.options, ...opts };
    const maxRetries = options.maxRetries ?? 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = sessionManager.revokeSession(sessionId, event);

      if (result.ok) {
        this.recordSuccess(sessionId);
        return result.value;
      }

      if (attempt < maxRetries) {
        const delay = this.exponentialBackoff(attempt, options.backoffMs ?? 100);
        await this.sleep(delay);
      }
    }

    throw {
      code: 'revocation_retries_exhausted',
      message: `Could not revoke session after ${maxRetries + 1} attempts`,
    };
  }

  private exponentialBackoff(attempt: number, baseMs: number): number {
    return baseMs * Math.pow(2, attempt);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private recordSuccess(identifier: string): void {
    this.lastPruneTime.set(identifier, new Date());
  }

  private recordError(error: RevocationError): void {
    this.revocationErrors.push(error);
    // Keep only last 100 errors
    if (this.revocationErrors.length > 100) {
      this.revocationErrors.shift();
    }
  }

  getRevocationErrors(limit: number = 50): RevocationError[] {
    return this.revocationErrors.slice(-limit);
  }

  clearRevocationErrors(): void {
    this.revocationErrors = [];
  }

  isRevocationInProgress(sessionId: string): boolean {
    return this.revocationInProgress.has(sessionId);
  }
}

export const revocationHandler = new RevocationHandler();
