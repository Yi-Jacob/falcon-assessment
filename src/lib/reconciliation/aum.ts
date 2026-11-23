// Pure AUM aggregation over reconciliation results. Integer cents only.
import { UNASSIGNED, type Result } from "./reconcile";

export interface Bucket { balanceCents: number; accounts: number }
export interface AumReport {
  label: string;
  grandTotalCents: number;
  byCustodian: Record<string, Bucket & { snapshotDate: string | null; excludedUnknownBalance: number; excludedConflicting: number; negativeAccounts: number; custodianOnlyIncluded: number }>;
  byAdvisor: Record<string, Bucket>;
  coverage: { custodianAccountsTotal: number; included: number; excluded: number; salesforceOnlyNotCounted: number };
  unresolved: {
    conflictingDuplicates: number; exactDuplicatesCollapsed: number;
    transferOverlapAccounts: number; transferOverlapExposureCents: number;
  };
  advisorDisagreements: { count: number; balanceCents: number };
}

export function computeAum(results: Result[]): AumReport {
  const byCustodian: AumReport["byCustodian"] = {};
  const byAdvisor: AumReport["byAdvisor"] = {};
  let grand = 0;
  let total = 0, included = 0, sfOnly = 0;
  const unresolved = { conflictingDuplicates: 0, exactDuplicatesCollapsed: 0, transferOverlapAccounts: 0, transferOverlapExposureCents: 0 };
  const dis = { count: 0, balanceCents: 0 };
  const has = (r: Result, c: string) => r.exceptions.some((e) => e.code === c);

  for (const r of results) {
    if (r.status === "salesforce_only") { sfOnly++; continue; }
    if (!r.observationIds.length || !r.custodian) continue; // invalid SF rows etc.
    total++;
    const c = (byCustodian[r.custodian] ??= { balanceCents: 0, accounts: 0, snapshotDate: null, excludedUnknownBalance: 0, excludedConflicting: 0, negativeAccounts: 0, custodianOnlyIncluded: 0 });
    if (r.valuationDate && (!c.snapshotDate || r.valuationDate > c.snapshotDate)) c.snapshotDate = r.valuationDate;
    if (has(r, "exact_duplicate")) unresolved.exactDuplicatesCollapsed++;
    if (has(r, "conflicting_duplicate")) { unresolved.conflictingDuplicates++; c.excludedConflicting++; }
    else if (!r.inAum) c.excludedUnknownBalance++;
    if (has(r, "possible_transfer_overlap")) { unresolved.transferOverlapAccounts++; unresolved.transferOverlapExposureCents += r.balanceCents ?? 0; }
    if (!r.inAum || r.balanceCents == null) continue;
    included++;
    c.balanceCents += r.balanceCents; c.accounts++; grand += r.balanceCents;
    if (r.balanceCents < 0) c.negativeAccounts++;
    if (r.status === "custodian_only") c.custodianOnlyIncluded++;
    const adv = r.custodianAdvisor ?? UNASSIGNED;
    const a = (byAdvisor[adv] ??= { balanceCents: 0, accounts: 0 });
    a.balanceCents += r.balanceCents; a.accounts++;
    if (has(r, "advisor_mismatch")) { dis.count++; dis.balanceCents += r.balanceCents; }
  }
  return {
    label: "Mixed-date, latest-available reported balances (NOT a synchronized point-in-time total; not transfer-adjusted)",
    grandTotalCents: grand, byCustodian, byAdvisor,
    coverage: { custodianAccountsTotal: total, included, excluded: total - included, salesforceOnlyNotCounted: sfOnly },
    unresolved, advisorDisagreements: dis,
  };
}

export const fmtMoney = (cents: number) => {
  const neg = cents < 0; const a = Math.abs(cents);
  const s = `${Math.floor(a / 100)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + String(a % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$${s}`;
};
