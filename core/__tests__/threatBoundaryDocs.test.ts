import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  THREAT_BOUNDARY_FIELDS,
  evaluateThreatBoundaryDoc,
  findSigningCalls,
  loadMigrationLedger,
  verifySlice
} from "../../scripts/verify-features.mjs";

const root = process.cwd();
const featuresDir = path.join(root, "features");
const ledgerPath = path.join(root, "scripts/threat-boundary-migration.json");

const slugs = readdirSync(featuresDir, { withFileTypes: true })
  .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith(".") && !dirent.name.startsWith("_"))
  .map((dirent) => dirent.name)
  .sort();

const documented = [
  "# Tool",
  "",
  "## Threat boundary",
  "",
  "- **Data sources:** the form field.",
  "- **Outbound requests:** None — runs entirely in the browser.",
  "- **Cannot sign or submit:** the schema rejects `S…` secrets.",
  "",
  "## Files"
].join("\n");

describe("threat-boundary documentation check", () => {
  it("passes a README that answers every field", () => {
    expect(evaluateThreatBoundaryDoc("tool", documented)).toEqual({
      slug: "tool",
      ok: true,
      hasSection: true,
      missing: []
    });
  });

  it("fails a README without the section, naming every field", () => {
    const result = evaluateThreatBoundaryDoc("tool", "# Tool\n\n## Safety\n\nRead-only.");
    expect(result.ok).toBe(false);
    expect(result.hasSection).toBe(false);
    expect(result.missing).toEqual([...THREAT_BOUNDARY_FIELDS]);
  });

  it("treats a missing README the same as a missing section", () => {
    expect(evaluateThreatBoundaryDoc("tool", undefined).missing).toEqual([...THREAT_BOUNDARY_FIELDS]);
  });

  it("does not accept the scaffold's TODO placeholders as answers", () => {
    const scaffolded = documented.replace("the form field.", "TODO: every input the tool reads.");
    expect(evaluateThreatBoundaryDoc("tool", scaffolded).missing).toEqual(["Data sources"]);
  });

  it("does not accept an empty answer", () => {
    const empty = documented.replace("**Outbound requests:** None — runs entirely in the browser.", "**Outbound requests:**");
    expect(evaluateThreatBoundaryDoc("tool", empty).missing).toEqual(["Outbound requests"]);
  });

  it("only reads fields inside the section, not elsewhere in the README", () => {
    const outside = [
      "# Tool",
      "- **Data sources:** the form field.",
      "## Threat boundary",
      "- **Outbound requests:** None.",
      "- **Cannot sign or submit:** no secrets accepted."
    ].join("\n");
    expect(evaluateThreatBoundaryDoc("tool", outside).missing).toEqual(["Data sources"]);
  });
});

describe("read-only signing scan", () => {
  it.each([
    ["const pair = Keypair.fromSecret(input);", "secret_keypair"],
    ["const pair = Keypair.random();", "secret_keypair"],
    ["tx.sign(pair);", "sign_call"],
    ["await freighter.signTransaction(xdr);", "wallet_sign"],
    ["await server.submitTransaction(tx);", "horizon_submit"],
    ['rpc("sendTransaction", { transaction })', "rpc_send"]
  ])("flags %s", (source, id) => {
    expect(findSigningCalls({ "lib/tool.ts": source })).toEqual([{ file: "lib/tool.ts", id }]);
  });

  it("ignores fixtures, tests, e2e specs and request mocks, which build signed samples", () => {
    const sources = {
      "fixtures/tool.fixture.ts": "tx.sign(source);",
      "__tests__/tool.test.ts": "Keypair.random();",
      "e2e/tool.spec.ts": "tx.sign(source);",
      "msw/handlers.ts": '"sendTransaction"'
    };
    expect(findSigningCalls(sources)).toEqual([]);
  });

  it("ignores comments and unrelated calls such as Math.sign and verify", () => {
    const sources = {
      "lib/tool.ts": [
        "// This tool never calls submitTransaction() or tx.sign().",
        "/* sendTransaction is deliberately absent */",
        "const direction = Math.sign(delta);",
        "const valid = keypair.verify(data, signature);",
        'const horizon = "https://horizon.stellar.org";'
      ].join("\n")
    };
    expect(findSigningCalls(sources)).toEqual([]);
  });
});

describe("threat-boundary migration ledger", () => {
  const pending = loadMigrationLedger(ledgerPath);

  it("only lists slices that exist", () => {
    expect([...pending].filter((slug) => !slugs.includes(slug))).toEqual([]);
  });

  it("does not list a slice that already documents its boundary", () => {
    // The ledger must shrink: once a README is complete its slug comes out.
    const stale = [...pending].filter((slug) => {
      const readme = path.join(featuresDir, slug, "README.md");
      let source: string | undefined;
      try {
        source = readFileSync(readme, "utf8");
      } catch {
        source = undefined;
      }
      return evaluateThreatBoundaryDoc(slug, source).ok;
    });
    expect(stale).toEqual([]);
  });

  it("documents the representative example, trustline-checker, outside the ledger", async () => {
    expect(pending.has("trustline-checker")).toBe(false);
    const result = await verifySlice("trustline-checker");
    expect(result.threatBoundaryPending).toBe(false);
    expect(result.threatBoundaryMissing).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("fails a slice that is neither documented nor on the ledger", async () => {
    const result = await verifySlice("trustline-limit-planner", { threatBoundaryPending: new Set() });
    expect(result.failures.some((failure) => failure.includes("Threat boundary"))).toBe(true);
  });

  it("finds no signing or submission call in any slice's runtime code", async () => {
    const offenders: string[] = [];
    for (const slug of slugs) {
      const result = await verifySlice(slug);
      offenders.push(...result.failures.filter((failure) => failure.includes("read-only boundary")).map((f) => `${slug}: ${f}`));
    }
    expect(offenders).toEqual([]);
  });
});
