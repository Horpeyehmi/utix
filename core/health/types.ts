/**
 * Types for operational health monitoring
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthIndicator {
  name: string;
  status: HealthStatus;
  message: string;
  details?: Record<string, unknown>;
  lastChecked: Date;
}

export interface UnresolvedException {
  id: string;
  timestamp: Date;
  type: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  resolved: boolean;
}

export interface StaleRecord {
  id: string;
  type: string;
  age: number;
  lastActivity: Date;
  details: Record<string, unknown>;
}

export interface JourneyStepResult {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  error?: string;
  dependency?: string;
}

export interface JourneyRun {
  id: string;
  journey: string;
  startedAt: Date;
  finishedAt: Date;
  status: HealthStatus;
  totalLatencyMs: number;
  steps: JourneyStepResult[];
  failedStep?: string;
  blamedDependency?: string;
}

export interface JourneyMonitorSummary {
  timestamp: Date;
  journey: string;
  status: HealthStatus;
  lastRun?: JourneyRun;
  recentRuns: JourneyRun[];
  metrics: {
    runCount: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    maxLatencyMs: number;
  };
}

export interface HealthSummary {
  timestamp: Date;
  overallStatus: HealthStatus;
  indicators: HealthIndicator[];
  unresolvedExceptions: UnresolvedException[];
  staleRecords: StaleRecord[];
  metrics: {
    totalFeatures: number;
    healthyFeatures: number;
    unresolvedExceptionCount: number;
    staleRecordCount: number;
  };
}
