// Pure reconciliation: plain data in, plain data out. No DB, no I/O.
import { registrationsConflict, householdPersonKeys, SUSPICIOUS_NOTE, TRANSFER_NOTE, type Registration } from "../ingest/normalize";

export type Cust = "Fidelity" | "Schwab";
export type Status = "matched" | "custodian_only" | "salesforce_only" | "ambiguous" | "invalid_identity";
export type Severity = "info" | "review" | "error";

export interface Obs {
  id: number; custodian: Cust; rawRef: string; accountKey: string | null; valuationDate: string | null;
  balanceCents: number | null; registration: Registration; ownerDisplay: string; ownerNameKey: string; repCode: string | null;
}
export interface SfAcct {
  sfId: string; householdId: string; custodian: Cust | null; accountKey: string | null; registration: Registration;
  status: string | null; notes: string | null; rawRef: string;
}
export interface Household { sfId: string; name: string; advisorName: string | null; email: string | null }
export interface ReconInput {
  observations: Obs[]; sfAccounts: SfAcct[]; households: Household[];
  repMap: Record<string, string>; // "Fidelity|WF7" -> advisor name
}
export interface Exc { code: string; severity: Severity; reason: string }
export interface Result {
  entityKey: string; custodian: Cust | null; accountKey: string | null; status: Status;
  balanceCents: number | null; inAum: boolean; valuationDate: string | null; repCode: string | null;
  custodianAdvisor: string | null; sfAdvisor: string | null; householdId: string | null;
  sfAccountIds: string[]; observationIds: number[]; rawRefs: string[]; ownerDisplay: string | null;
  exceptions: Exc[];
}
export const UNASSIGNED = "Unassigned";
export const repKey = (c: string, code: string) => `${c}|${code.toUpperCase()}`;

const group = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); (m.get(k) ?? m.set(k, []).get(k)!).push(x); }
  return m;
};
const stripZeros = (k: string) => k.replace(/^0+/, "");
const obsSig = (o: Obs) => JSON.stringify([o.balanceCents, o.registration, o.ownerDisplay, o.repCode, o.valuationDate]);
const TRANSFER_BALANCE_TOLERANCE = 0.1;

export function reconcile(input: ReconInput): Result[] {
  const { observations, sfAccounts, households, repMap } = input;
  const hh = new Map(households.map((h) => [h.sfId, h]));
  const results: Result[] = [];

  const validObs = observations.filter((o) => o.accountKey && o.valuationDate !== undefined);
  const snapshot: Partial<Record<Cust, string>> = {};
  for (const o of observations) if (o.valuationDate && (!snapshot[o.custodian] || o.valuationDate > snapshot[o.custodian]!)) snapshot[o.custodian] = o.valuationDate;

  const obsByKey = group(validObs, (o) => `${o.custodian}|${o.accountKey}`);
  const sfValid = sfAccounts.filter((s) => s.custodian && s.accountKey);
  const sfByKey = group(sfValid, (s) => `${s.custodian}|${s.accountKey}`);

  // ---- invalid identities: every source row still gets a result ----
  for (const o of observations.filter((o) => !o.accountKey)) {
    results.push(blank(`invalid:obs:${o.id}`, o.custodian, null, "invalid_identity", { observationIds: [o.id], rawRefs: [o.rawRef], ownerDisplay: o.ownerDisplay },
      [{ code: "invalid_identity", severity: "error", reason: "Custodian account number is empty or contains unsupported characters." }]));
  }
  for (const s of sfAccounts.filter((s) => !s.custodian || !s.accountKey)) {
    results.push(blank(`invalid:sf:${s.sfId}`, s.custodian, null, "invalid_identity", { sfAccountIds: [s.sfId], rawRefs: [s.rawRef], householdId: s.householdId },
      [{ code: "invalid_identity", severity: "error", reason: !s.custodian ? "Salesforce custodian is unrecognized." : "Salesforce account number is empty or malformed." }]));
  }

  const keys = new Set([...obsByKey.keys(), ...sfByKey.keys()]);
  const byEntity = new Map<string, Result>();
  for (const key of [...keys].sort()) {
    const [custodian, accountKey] = [key.split("|")[0] as Cust, key.split("|")[1]];
    const group_ = obsByKey.get(key) ?? [];
    const sfs = sfByKey.get(key) ?? [];
    const exceptions: Exc[] = [];
    const add = (code: string, severity: Severity, reason: string) => exceptions.push({ code, severity, reason });

    // ---- duplicate detection BEFORE any join ----
    let used: Obs | null = null;
    let balance: number | null = null;
    let inAum = false;
    let date: string | null = null;
    if (group_.length) {
      date = group_.reduce((m, o) => (o.valuationDate! > m ? o.valuationDate! : m), group_[0].valuationDate ?? "");
      const latest = group_.filter((o) => o.valuationDate === date);
      const older = group_.length - latest.length;
      if (older) add("superseded_observation", "info", `${older} older observation(s) for this account retained as lineage but not counted.`);
      if (latest.length > 1) {
        if (new Set(latest.map(obsSig)).size === 1) {
          add("exact_duplicate", "review", `${latest.length} identical rows for the same account/date; balance counted once, all rows retained as lineage.`);
          used = latest[0];
        } else {
          add("conflicting_duplicate", "error", `${latest.length} rows for the same account/date disagree; no winner chosen, value excluded from AUM.`);
        }
      } else used = latest[0];
      if (date && snapshot[custodian] && date < snapshot[custodian]!) add("mixed_valuation_dates", "review", `Latest observation ${date} is older than the ${custodian} snapshot ${snapshot[custodian]}.`);
      if (used) {
        if (used.balanceCents == null) add("missing_balance", "review", "Balance is blank or malformed; treated as unknown (not zero) and excluded from AUM.");
        else {
          balance = used.balanceCents; inAum = true;
          if (balance < 0) add("negative_balance", "review", "Negative balance (e.g. margin debit). Included in net total and flagged.");
        }
      }
    }

    // ---- advisor ----
    const rep = (used ?? group_[0])?.repCode ?? null;
    let custAdvisor: string | null = null;
    if (group_.length) {
      custAdvisor = rep ? repMap[repKey(custodian, rep)] ?? null : null;
      if (!custAdvisor) { add("unknown_rep_code", "review", `Rep code ${rep ?? "(blank)"} is not mapped for ${custodian}; attributed to ${UNASSIGNED}.`); custAdvisor = UNASSIGNED; }
    }
    const sfHh = sfs.length ? hh.get(sfs[0].householdId) : undefined;
    const sfAdvisor = sfHh?.advisorName ?? null;
    if (sfs.length && !sfHh) add("orphan_household_link", "error", "Salesforce account points to a household id not present in sf_households.");
    if (custAdvisor && custAdvisor !== UNASSIGNED && sfAdvisor && custAdvisor !== sfAdvisor)
      add("advisor_mismatch", "review", `Custodian rep code maps to ${custAdvisor}, Salesforce household owner is ${sfAdvisor}. AUM follows the custodian mapping.`);

    // ---- status ----
    let status: Status;
    if (sfs.length > 1) {
      status = "ambiguous";
      add("duplicate_salesforce_account", "error", `${sfs.length} Salesforce accounts share this custodian + number: ${sfs.map((s) => s.sfId).join(", ")}.`);
    } else status = group_.length && sfs.length ? "matched" : group_.length ? "custodian_only" : "salesforce_only";

    if (status === "custodian_only") add("not_in_salesforce", "review", "Account exists at the custodian but has no Salesforce financial account.");
    if (status === "salesforce_only") {
      const closed = sfs[0].status?.toLowerCase() === "closed";
      add("not_at_custodian", closed ? "info" : "review", closed ? "Closed in Salesforce and absent from the custodian file: expected." : "Salesforce account is absent from the latest custodian file.");
    }

    // ---- registration / status / notes ----
    const reg = used?.registration ?? group_[0]?.registration;
    if (reg === "unknown") add("unknown_registration", "review", "Custodian registration label is not in the mapping table.");
    if (sfs.length && sfs[0].registration === "unknown") add("unknown_registration", "review", "Salesforce registration label is not in the mapping table.");
    if (reg && sfs.length === 1 && registrationsConflict(reg, sfs[0].registration)) add("registration_mismatch", "review", `Custodian registration ${reg} vs Salesforce ${sfs[0].registration}.`);
    for (const s of sfs) {
      const st = s.status?.toLowerCase();
      if (group_.length && st === "closed") add("status_conflict", "error", "Salesforce says Closed but the custodian still reports this account.");
      if (st === "transferring" || (s.notes && TRANSFER_NOTE.test(s.notes))) add("possible_transfer_overlap", "review", "Salesforce marks a transfer in flight; balance may also appear at the other custodian. Not adjusted.");
      if (s.notes && SUSPICIOUS_NOTE.test(s.notes)) add("suspicious_note_content", "review", "Salesforce note contains instruction-like text. Treated as data only; never acted on.");
    }

    const r: Result = {
      entityKey: key, custodian, accountKey, status, balanceCents: balance, inAum, valuationDate: date, repCode: rep,
      custodianAdvisor: custAdvisor, sfAdvisor, householdId: sfs[0]?.householdId ?? null,
      sfAccountIds: sfs.map((s) => s.sfId), observationIds: group_.map((o) => o.id), rawRefs: [...group_.map((o) => o.rawRef), ...sfs.map((s) => s.rawRef)],
      ownerDisplay: (used ?? group_[0])?.ownerDisplay ?? null, exceptions,
    };
    byEntity.set(key, r);
    results.push(r);
  }

  const addExc = (r: Result, code: string, severity: Severity, reason: string) => { if (!r.exceptions.some((e) => e.code === code)) r.exceptions.push({ code, severity, reason }); };

  // ---- cross-entity review signals (never auto-link) ----
  const custOnly = [...byEntity.values()].filter((r) => r.status === "custodian_only");
  const sfOnly = [...byEntity.values()].filter((r) => r.status === "salesforce_only");
  for (const c of custOnly) {
    for (const s of sfOnly) {
      if (c.custodian === s.custodian && stripZeros(c.accountKey!) === stripZeros(s.accountKey!) && c.accountKey !== s.accountKey) {
        const reason = `Account numbers differ only by leading zeros (${c.accountKey} vs ${s.accountKey}); candidate for human review, not linked.`;
        addExc(c, "possible_account_number_typo", "review", reason); addExc(s, "possible_account_number_typo", "review", reason);
      }
      if (c.custodian !== s.custodian && c.accountKey === s.accountKey) {
        const reason = `Same account number appears at ${c.custodian} and is claimed by Salesforce under ${s.custodian}; candidate for review, not linked.`;
        addExc(c, "custodian_mismatch_candidate", "review", reason); addExc(s, "custodian_mismatch_candidate", "review", reason);
      }
    }
  }

  // household duplicates: shared email or shared person name (signal only)
  const emailG = group(households.filter((h) => h.email), (h) => h.email!);
  const personG = new Map<string, Set<string>>();
  for (const h of households) for (const p of householdPersonKeys(h.name)) (personG.get(p) ?? personG.set(p, new Set()).get(p)!).add(h.sfId);
  const dupPartners = new Map<string, Set<string>>();
  const link = (ids: string[]) => ids.forEach((a) => ids.forEach((b) => a !== b && (dupPartners.get(a) ?? dupPartners.set(a, new Set()).get(a)!).add(b)));
  for (const g of emailG.values()) if (g.length > 1) link(g.map((h) => h.sfId));
  for (const s of personG.values()) if (s.size > 1) link([...s]);
  for (const r of results) {
    const p = r.householdId ? dupPartners.get(r.householdId) : undefined;
    if (p?.size) addExc(r, "possible_duplicate_household", "review", `Household ${r.householdId} shares an email or client name with ${[...p].join(", ")}. Review before any merge; names/emails are not proof.`);
  }

  // transfer overlap counterpart: other-custodian accounts for the same owner name & registration, similar balance
  const transferring = results.filter((r) => r.exceptions.some((e) => e.code === "possible_transfer_overlap") && r.observationIds.length);
  const obsById = new Map(observations.map((o) => [o.id, o]));
  for (const t of transferring) {
    const to = obsById.get(t.observationIds[0])!;
    for (const r of results) {
      if (r === t || !r.observationIds.length || r.custodian === t.custodian) continue;
      const o = obsById.get(r.observationIds[0])!;
      const near = t.balanceCents != null && r.balanceCents != null && t.balanceCents !== 0 && Math.abs(r.balanceCents - t.balanceCents) / Math.abs(t.balanceCents) <= TRANSFER_BALANCE_TOLERANCE;
      if (o.ownerNameKey === to.ownerNameKey && o.registration === to.registration && near) {
        const reason = `Possible double count with ${t.custodian} ${t.accountKey} (transfer in flight; same owner name, registration, balance within ${TRANSFER_BALANCE_TOLERANCE * 100}%). Not adjusted; needs human confirmation.`;
        addExc(r, "possible_transfer_overlap", "review", reason);
        addExc(t, "possible_transfer_overlap", "review", `Counterpart ${r.custodian} ${r.accountKey} may hold the same assets.`);
      }
    }
  }
  return results;
}

function blank(entityKey: string, custodian: Cust | null, accountKey: string | null, status: Status, p: Partial<Result>, exceptions: Exc[]): Result {
  return { entityKey, custodian, accountKey, status, balanceCents: null, inAum: false, valuationDate: null, repCode: null, custodianAdvisor: null, sfAdvisor: null,
    householdId: null, sfAccountIds: [], observationIds: [], rawRefs: [], ownerDisplay: null, exceptions, ...p };
}
