import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/lib/db/db";
import { DEFAULT_FILES, ingestFiles, type SourceType } from "../src/lib/ingest/ingest";
import { normalizeAccountNumber, normalizeRegistration, parseDate, parseMoneyToCents } from "../src/lib/ingest/normalize";
import { computeAum } from "../src/lib/reconciliation/aum";
import { reconcile, type Obs, type ReconInput, type SfAcct } from "../src/lib/reconciliation/reconcile";
import { loadInput, runReconciliation } from "../src/lib/reconciliation/run";

describe("normalization", () => {
  it("keeps leading zeros and strips only hyphens/spaces", () => {
    expect(normalizeAccountNumber("08855469")).toBe("08855469");
    expect(normalizeAccountNumber(" z21-544 479 ")).toBe("Z21544479");
    expect(normalizeAccountNumber("")).toBeNull();
    expect(normalizeAccountNumber("12/34")).toBeNull();
  });
  it("parses money to integer cents; blank is unknown", () => {
    expect(parseMoneyToCents("$1,582,119.28")).toEqual({ kind: "ok", cents: 158211928 });
    expect(parseMoneyToCents("-$12,500.00")).toEqual({ kind: "ok", cents: -1250000 });
    expect(parseMoneyToCents("218378.5")).toEqual({ kind: "ok", cents: 21837850 });
    expect(parseMoneyToCents("")).toEqual({ kind: "blank" });
    expect(parseMoneyToCents("12abc").kind).toBe("invalid");
  });
  it("parses explicit date formats and rejects impossible dates", () => {
    expect(parseDate("11/06/2026", "mdy")).toBe("2026-11-06");
    expect(parseDate("2026-10-30", "iso")).toBe("2026-10-30");
    expect(parseDate("13/45/2026", "mdy")).toBeNull();
  });
  it("maps registrations and flags unknowns", () => {
    expect(normalizeRegistration("TRUST-REVOCABLE")).toBe("trust");
    expect(normalizeRegistration("Roth Contributory IRA")).toBe("ira_roth");
    expect(normalizeRegistration("Custodial UTMA")).toBe("unknown");
  });
});

const obs = (id: number, o: Partial<Obs> = {}): Obs => ({
  id, custodian: "Fidelity", rawRef: `f#${id}`, accountKey: "Z1", valuationDate: "2026-11-06", balanceCents: 10000, registration: "individual",
  ownerDisplay: "A", ownerNameKey: "a", repCode: "WF7", ...o,
});
const sf = (o: Partial<SfAcct> = {}): SfAcct => ({ sfId: "a1", householdId: "h1", custodian: "Fidelity", accountKey: "Z1", registration: "individual", status: "Open", notes: null, rawRef: "sf#1", ...o });
const base = (p: Partial<ReconInput>): ReconInput => ({
  observations: [], sfAccounts: [], households: [{ sfId: "h1", name: "A Household", advisorName: "Dana", email: "a@x.com" }],
  repMap: { "Fidelity|WF7": "Dana", "Schwab|DW01": "Dana" }, ...p,
});

describe("reconciliation", () => {
  it("counts exact duplicates once and keeps lineage", () => {
    const r = reconcile(base({ observations: [obs(1), obs(2)], sfAccounts: [sf()] }));
    expect(r).toHaveLength(1);
    expect(r[0].exceptions.map((e) => e.code)).toContain("exact_duplicate");
    expect(r[0].balanceCents).toBe(10000);
    expect(r[0].observationIds).toEqual([1, 2]);
  });
  it("excludes conflicting same-date duplicates instead of picking a winner", () => {
    const r = reconcile(base({ observations: [obs(1), obs(2, { balanceCents: 99 })], sfAccounts: [sf()] }));
    expect(r[0].inAum).toBe(false);
    expect(r[0].exceptions.map((e) => e.code)).toContain("conflicting_duplicate");
  });
  it("leading-zero difference is a candidate only, never a match", () => {
    const r = reconcile(base({ observations: [obs(1, { custodian: "Schwab", accountKey: "08855469", repCode: "DW01" })], sfAccounts: [sf({ custodian: "Schwab", accountKey: "8855469" })] }));
    expect(r.map((x) => x.status).sort()).toEqual(["custodian_only", "salesforce_only"]);
    expect(r.every((x) => x.exceptions.some((e) => e.code === "possible_account_number_typo"))).toBe(true);
  });
  it("same number at a different custodian is never auto-linked", () => {
    const r = reconcile(base({ observations: [obs(1)], sfAccounts: [sf({ custodian: "Schwab" })] }));
    expect(r.map((x) => x.status).sort()).toEqual(["custodian_only", "salesforce_only"]);
    expect(r.every((x) => x.exceptions.some((e) => e.code === "custodian_mismatch_candidate"))).toBe(true);
  });
  it("blank balance is unknown and unmapped rep code goes to Unassigned", () => {
    const r = reconcile(base({ observations: [obs(1, { balanceCents: null, repCode: "ZZ9" })] }));
    const codes = r[0].exceptions.map((e) => e.code);
    expect(codes).toContain("missing_balance");
    expect(codes).toContain("unknown_rep_code");
    expect(r[0].custodianAdvisor).toBe("Unassigned");
    expect(computeAum(r).grandTotalCents).toBe(0);
  });
  it("advisor comes from custodian+rep code, and negatives are included", () => {
    const r = reconcile(base({ observations: [obs(1, { balanceCents: -500 })], sfAccounts: [sf()], households: [{ sfId: "h1", name: "A Household", advisorName: "Other", email: null }] }));
    const codes = r[0].exceptions.map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(["negative_balance", "advisor_mismatch"]));
    const aum = computeAum(r);
    expect(aum.byAdvisor["Dana"].balanceCents).toBe(-500);
  });
  it("Salesforce-only accounts do not add AUM", () => {
    const aum = computeAum(reconcile(base({ sfAccounts: [sf()] })));
    expect(aum.grandTotalCents).toBe(0);
    expect(aum.coverage.salesforceOnlyNotCounted).toBe(1);
  });
});

describe("ingestion", () => {
  it("is idempotent for identical files and keeps raw rows immutable", () => {
    const db = openDb(":memory:");
    const files = (Object.keys(DEFAULT_FILES) as SourceType[]).map((type) => ({ type, path: join("data", DEFAULT_FILES[type]) }));
    ingestFiles(db, files);
    const first = runReconciliation(db);
    const total1 = computeAum(first.results).grandTotalCents;
    const again = ingestFiles(db, files);
    expect(again.every((s) => s.status === "skipped_identical")).toBe(true);
    const second = runReconciliation(db);
    expect(second.reused).toBe(true);
    expect(computeAum(second.results).grandTotalCents).toBe(total1);
    expect((db.prepare("SELECT COUNT(*) c FROM custodian_observations").get() as any).c).toBe(65);
    expect(() => db.prepare("UPDATE raw_rows SET values_json='x'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM raw_files").run()).toThrow(/immutable/);
    // every raw custodian row and every SF account is represented in results
    const covered = new Set(second.results.flatMap((r) => r.observationIds));
    expect(covered.size).toBe(65);
    expect(new Set(second.results.flatMap((r) => r.sfAccountIds)).size).toBe(63);
  });
  it("rejects files with unexpected columns", () => {
    const db = openDb(":memory:");
    const d = mkdtempSync(join(tmpdir(), "falcon-"));
    writeFileSync(join(d, "rep.csv"), "a,b\n1,2\n");
    expect(() => ingestFiles(db, [{ type: "rep_codes", path: join(d, "rep.csv") }])).toThrow(/unexpected columns/);
    expect((db.prepare("SELECT COUNT(*) c FROM raw_files").get() as any).c).toBe(0); // transaction rolled back
  });
});
