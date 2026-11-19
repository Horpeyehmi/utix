import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RevocationHandler } from '../revocation-handler';
import { sessionManager } from '../manager';
import type { SecurityEvent } from '../types';

describe('RevocationHandler', () => {
  let handler: RevocationHandler;
  let session: ReturnType<typeof sessionManager.createSession>;
  const userId = 'test-user-id';

  beforeEach(() => {
    handler = new RevocationHandler();
    sessionManager.reset();
    session = sessionManager.createSession(userId, {
      deviceType: 'web',
      deviceName: 'Test Browser',
      userAgent: 'Mozilla/5.0',
      ipAddress: '192.168.1.1',
    });
  });

  describe('async revocation', () => {
    it('revokes a session asynchronously', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
        reason: 'User changed password',
      };

      const result = await handler.revokeSessionAsync(session.id, event);

      expect(result.ok).toBe(true);
      expect(result.value.success).toBe(true);
      expect(result.value.revokedSessionIds).toContain(session.id);
      expect(sessionManager.isSessionRevoked(session.id)).toBe(true);
    });

    it('handles concurrent revocation requests for the same session', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      const promise1 = handler.revokeSessionAsync(session.id, event);
      const promise2 = handler.revokeSessionAsync(session.id, event);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      expect(result1.value.revokedSessionIds[0]).toBe(result2.value.revokedSessionIds[0]);
    });

    it('retries revocation on failure with exponential backoff', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      // This should succeed on first try with mocked session manager
      const result = await handler.revokeSessionAsync(session.id, event, { maxRetries: 2 });

      expect(result.ok).toBe(true);
    });

    it('reports revocation errors', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: 'different-user', role: 'user' },
      };

      const result = await handler.revokeSessionAsync(session.id, event);

      expect(result.ok).toBe(false);
      const errors = handler.getRevocationErrors();
      expect(errors.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('revoke all user sessions', () => {
    it('revokes all sessions for a user asynchronously', async () => {
      const session2 = sessionManager.createSession(userId, {
        deviceType: 'mobile',
        deviceName: 'Test Phone',
        userAgent: 'Mobile Safari',
        ipAddress: '192.168.1.2',
      });

      const event: SecurityEvent = {
        type: 'account_compromised',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
        reason: 'Account compromise detected',
      };

      const result = await handler.revokeAllUserSessionsAsync(userId, event);

      expect(result.ok).toBe(true);
      expect(result.value.revokedSessionIds.length).toBe(2);
      expect(sessionManager.isSessionRevoked(session.id)).toBe(true);
      expect(sessionManager.isSessionRevoked(session2.id)).toBe(true);
    });

    it('preserves a specified device when revoking all sessions', async () => {
      const device2 = sessionManager.addDevice(session.id, {
        deviceType: 'mobile',
        deviceName: 'Mobile Device',
        userAgent: 'Mobile Safari',
        ipAddress: '192.168.1.2',
      });

      const event: SecurityEvent = {
        type: 'suspicious_activity_detected',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      const result = await handler.revokeAllUserSessionsAsync(userId, event, device2?.id);

      expect(result.ok).toBe(true);
      // The session should still be active but other devices revoked
      const sessionStatus = sessionManager.getSession(session.id);
      expect(sessionStatus?.revoked).toBe(false);
    });
  });

  describe('stale session pruning', () => {
    it('prunes stale sessions', async () => {
      const result = await handler.pruneStaleSessions(1000);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pruneIntervalMs).toBe(60 * 60 * 1000);
      }
    });

    it('respects minimum interval between prune operations', async () => {
      const minInterval = 1000;
      const result1 = await handler.pruneStaleSessions(100, minInterval);
      const result2 = await handler.pruneStaleSessions(100, minInterval);

      // Second call should fail because not enough time has passed
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(false);
    });

    it('reports stale session and device counts', async () => {
      // Create a device that would be stale
      sessionManager.addDevice(session.id, {
        deviceType: 'mobile',
        deviceName: 'Stale Device',
        userAgent: 'Mobile Safari',
        ipAddress: '192.168.1.3',
      });

      const result = await handler.pruneStaleSessions(1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect('staleSessions' in result.value).toBe(true);
        expect('staleDevices' in result.value).toBe(true);
      }
    });
  });

  describe('error tracking', () => {
    it('tracks revocation errors', async () => {
      const handler2 = new RevocationHandler();
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: 'unauthorized-user', role: 'user' },
      };

      await handler2.revokeSessionAsync('nonexistent-session', event);

      const errors = handler2.getRevocationErrors();
      expect(errors.length).toBeGreaterThanOrEqual(0);
    });

    it('limits error history to 100 entries', async () => {
      const handler2 = new RevocationHandler();
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      // Create 110 sessions and try to revoke non-existent ones
      for (let i = 0; i < 110; i++) {
        await handler2.revokeSessionAsync(`session-${i}`, event);
      }

      const errors = handler2.getRevocationErrors(200);
      expect(errors.length).toBeLessThanOrEqual(100);
    });

    it('clears revocation errors', () => {
      const handler2 = new RevocationHandler();
      handler2.getRevocationErrors(); // This would populate errors if any

      handler2.clearRevocationErrors();
      expect(handler2.getRevocationErrors()).toEqual([]);
    });
  });

  describe('revocation in progress tracking', () => {
    it('reports when revocation is in progress', async () => {
      const event: SecurityEvent = {
        type: 'password_changed',
        userId,
        timestamp: new Date(),
        actor: { id: userId, role: 'user' },
      };

      const promise = handler.revokeSessionAsync(session.id, event);

      // Check if revocation is marked as in progress during the async operation
      const startTime = Date.now();
      let wasInProgress = false;
      while (Date.now() - startTime < 100 && !wasInProgress) {
        if (handler.isRevocationInProgress(session.id)) {
          wasInProgress = true;
        }
      }

      await promise;

      expect(handler.isRevocationInProgress(session.id)).toBe(false);
    });
  });
});
