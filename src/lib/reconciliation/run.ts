import { createHash } from "node:crypto";
import type { Db } from "../db/db";
import { reconcile, repKey, type Cust, type ReconInput, type Result } from "./reconcile";

/** Load canonical rows into the pure reconciler's input shape. */
export function loadInput(db: Db): ReconInput {
  const fileRow = (rawRowId: number) => {
    const r = db.prepare("SELECT f.filename, r.row_number FROM raw_rows r JOIN raw_files f ON f.id=r.file_id WHERE r.id=?").get(rawRowId) as { filename: string; row_number: number };
    return `${r.filename}#${r.row_number}`;
  };
  const observations = (db.prepare("SELECT * FROM custodian_observations ORDER BY id").all() as any[]).map((o) => ({
    id: o.id, custodian: o.custodian as Cust, rawRef: fileRow(o.raw_row_id), accountKey: o.account_key, valuationDate: o.valuation_date,
    balanceCents: o.balance_cents, registration: o.registration, ownerDisplay: o.owner_display ?? "", ownerNameKey: o.owner_name_key ?? "", repCode: o.rep_code,
  }));
  const sfAccounts = (db.prepare("SELECT * FROM sf_financial_accounts ORDER BY sf_id").all() as any[]).map((s) => ({
    sfId: s.sf_id, householdId: s.household_sf_id, custodian: s.custodian, accountKey: s.account_key, registration: s.registration, status: s.status, notes: s.notes, rawRef: fileRow(s.raw_row_id),
  }));
  const households = (db.prepare("SELECT * FROM households ORDER BY sf_id").all() as any[]).map((h) => ({ sfId: h.sf_id, name: h.name, advisorName: h.primary_advisor_name, email: h.primary_email }));
  const repMap: Record<string, string> = {};
  for (const m of db.prepare("SELECT m.custodian, m.rep_code, a.name FROM rep_code_map m JOIN advisors a ON a.id=m.advisor_id").all() as any[]) repMap[repKey(m.custodian, m.rep_code)] = m.name;
  return { observations, sfAccounts, households, repMap };
}

/** Run reconciliation and persist results. Idempotent: same inputs reuse the existing run. */
export function runReconciliation(db: Db, now = new Date().toISOString()): { runId: number; results: Result[]; reused: boolean } {
  const input = loadInput(db);
  const results = reconcile(input);
  const fp = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const prior = db.prepare("SELECT id FROM recon_runs WHERE input_fingerprint=?").get(fp) as { id: number } | undefined;
  if (prior) return { runId: prior.id, results, reused: true };
  const tx = db.transaction(() => {
    const runId = Number(db.prepare("INSERT INTO recon_runs(created_at,input_fingerprint,policy) VALUES (?,?,?)").run(now, fp, JSON.stringify({ valuation: "custodian latest snapshot", dedupe: "exact only" })).lastInsertRowid);
    const ins = db.prepare("INSERT INTO recon_results(run_id,entity_key,custodian,account_key,status,balance_cents,in_aum,valuation_date,rep_code,custodian_advisor,sf_advisor,household_sf_id,sf_account_ids,observation_ids,raw_row_refs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const insE = db.prepare("INSERT INTO recon_exceptions(result_id,code,severity,reason) VALUES (?,?,?,?)");
    for (const r of results) {
      const id = Number(ins.run(runId, r.entityKey, r.custodian, r.accountKey, r.status, r.balanceCents, r.inAum ? 1 : 0, r.valuationDate, r.repCode, r.custodianAdvisor, r.sfAdvisor, r.householdId,
        JSON.stringify(r.sfAccountIds), JSON.stringify(r.observationIds), JSON.stringify(r.rawRefs)).lastInsertRowid);
      for (const e of r.exceptions) insE.run(id, e.code, e.severity, e.reason);
    }
    return runId;
  });
  return { runId: tx(), results, reused: false };
}
