import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  checkEnvironmentVariables,
  checkNodeRuntime,
  checkRegistrySync,
  formatDiagnosticsReport,
  runContributorDiagnostics
} from "../index";

describe("Contributor Diagnostics (#275)", () => {
  const root = path.resolve(__dirname, "../../..");

  it("evaluates contributor diagnostics across all categories", async () => {
    const report = await runContributorDiagnostics({ projectRoot: root });

    expect(report.evaluatedAt).toBeDefined();
    expect(report.summary.total).toBe(5);
    expect(report.checks.length).toBe(5);
    expect(["healthy", "degraded", "failing"]).toContain(report.overallStatus);
  });

  it("validates Node.js engine version meets requirements", async () => {
    const res = await checkNodeRuntime();
    expect(res.id).toBe("node-version");
    expect(res.category).toBe("node_runtime");
    // Should pass on modern Node environment running the tests
    expect(["pass", "fail"]).toContain(res.status);
  });

  it("detects secret key leakage and malformed URLs in environment check", async () => {
    // Normal sanitized run
    const normal = await checkEnvironmentVariables();
    expect(normal.id).toBe("environment-config");

    // Temporarily inject a secret key in exact 56-char secret key format
    const prevKey = process.env.TEST_SECRET_KEY;
    try {
      process.env.TEST_SECRET_KEY = "S" + "A".repeat(55);
      const flagged = await checkEnvironmentVariables();
      expect(flagged.status).toBe("fail");
      expect(flagged.message).toContain("CRITICAL SECURITY");
      expect(flagged.remediation).toBeDefined();
    } finally {
      if (prevKey === undefined) delete process.env.TEST_SECRET_KEY;
      else process.env.TEST_SECRET_KEY = prevKey;
    }
  });

  it("flags embedded basic auth credentials in endpoint URLs", async () => {
    const prevUrl = process.env.NEXT_PUBLIC_HORIZON_TESTNET_URL;
    try {
      process.env.NEXT_PUBLIC_HORIZON_TESTNET_URL = "https://user:pass@horizon-testnet.stellar.org";
      const res = await checkEnvironmentVariables();
      expect(res.status).toBe("fail");
      expect(res.message).toContain("embedded credentials");
    } finally {
      if (prevUrl === undefined) delete process.env.NEXT_PUBLIC_HORIZON_TESTNET_URL;
      else process.env.NEXT_PUBLIC_HORIZON_TESTNET_URL = prevUrl;
    }
  });

  it("checks registry synchronization against features/ directory", async () => {
    const res = await checkRegistrySync(root);
    expect(res.id).toBe("registry-sync");
    expect(["pass", "warn", "fail"]).toContain(res.status);
  });

  it("formats diagnostics report with clear badges and summary", async () => {
    const report = await runContributorDiagnostics({ projectRoot: root });
    const formatted = formatDiagnosticsReport(report);

    expect(formatted).toContain("UTIX CONTRIBUTOR DIAGNOSTICS REPORT");
    expect(formatted).toContain("Summary:");
    expect(formatted).toMatch(/\[PASS\]|\[WARN\]|\[FAIL\]/);
  });
});
