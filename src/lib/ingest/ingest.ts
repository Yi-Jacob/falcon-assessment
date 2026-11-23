import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { Db } from "../db/db";
import {
  custodianOwnerDisplay,
  normalizeAccountNumber,
  normalizeRegistration,
  ownerNameKey,
  parseCustodian,
  parseDate,
  parseMoneyToCents,
} from "./normalize";

export type SourceType = "fidelity" | "schwab" | "sf_households" | "sf_financial_accounts" | "rep_codes";

// Zod validates the *shape* (required headers, all strings). Values stay untrusted data.
const str = z.string();
const SHAPES: Record<SourceType, z.ZodObject<any>> = {
  fidelity: z.object({ "Acct Number": str, Registration: str, "Primary Owner": str, "Joint Owner": str, "Tax ID": str, "Market Value": str, "As Of": str, "Rep Code": str }),
  schwab: z.object({ account_id: str, account_title: str, account_type: str, total_value: str, value_date: str, advisor_code: str, ssn_last4: str }),
  sf_households: z.object({ Id: str, Name: str, Primary_Advisor__c: str, Primary_Email__c: str, CreatedDate: str }),
  sf_financial_accounts: z.object({ Id: str, Household__c: str, Account_Number__c: str, Custodian__c: str, Registration_Type__c: str, Status__c: str, Notes__c: str }),
  rep_codes: z.object({ rep_code: str, custodian: str, advisor_name: str }),
};

export interface IngestFile { type: SourceType; path: string }
export interface IngestSummary { file: string; status: "imported" | "skipped_identical"; rows: number; sha256: string }

export const DEFAULT_FILES: Record<SourceType, string> = {
  fidelity: "fidelity_accounts_2026-11-06.csv",
  schwab: "schwab_balances_20261030.csv",
  sf_households: "sf_households.csv",
  sf_financial_accounts: "sf_financial_accounts.csv",
  rep_codes: "rep_codes.csv",
};

export function parseCsvRaw(bytes: Buffer): Record<string, string>[] {
  // columns:true keeps every value as an unmodified string; bom handles Excel exports.
  return parse(bytes, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: false, trim: false });
}

export function ingestFiles(db: Db, files: IngestFile[], now = new Date().toISOString()): IngestSummary[] {
  const out: IngestSummary[] = [];
  const run = db.transaction(() => {
    const batchId = Number(db.prepare("INSERT INTO import_batches(started_at) VALUES (?)").run(now).lastInsertRowid);
    // rep codes first so advisors exist, then households, then the rest
    const order: SourceType[] = ["rep_codes", "sf_households", "sf_financial_accounts", "fidelity", "schwab"];
    for (const f of [...files].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))) {
      const bytes = readFileSync(f.path);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const filename = basename(f.path);
      const existing = db.prepare("SELECT id FROM raw_files WHERE sha256 = ?").get(sha);
      if (existing) {
        out.push({ file: filename, status: "skipped_identical", rows: 0, sha256: sha });
        continue;
      }
      const rows = parseCsvRaw(bytes);
      const shape = SHAPES[f.type];
      rows.forEach((r, i) => {
        const res = shape.safeParse(r);
        if (!res.success) throw new Error(`${filename} row ${i + 1}: unexpected columns (${res.error.issues[0]?.path.join(",")})`);
      });
      const fileId = Number(
        db.prepare("INSERT INTO raw_files(batch_id,source_type,filename,sha256,byte_size,content,ingested_at) VALUES (?,?,?,?,?,?,?)")
          .run(batchId, f.type, filename, sha, bytes.length, bytes, now).lastInsertRowid,
      );
      const insRow = db.prepare("INSERT INTO raw_rows(file_id,row_number,values_json) VALUES (?,?,?)");
      const rawIds = rows.map((r, i) => Number(insRow.run(fileId, i + 1, JSON.stringify(r)).lastInsertRowid));
      buildCanonical(db, f.type, rows, rawIds);
      out.push({ file: filename, status: "imported", rows: rows.length, sha256: sha });
    }
  });
  run();
  return out;
}

function buildCanonical(db: Db, type: SourceType, rows: Record<string, string>[], rawIds: number[]) {
  switch (type) {
    case "rep_codes": {
      const insA = db.prepare("INSERT OR IGNORE INTO advisors(name) VALUES (?)");
      const getA = db.prepare("SELECT id FROM advisors WHERE name = ?");
      const ins = db.prepare("INSERT OR REPLACE INTO rep_code_map(custodian,rep_code,advisor_id,raw_row_id) VALUES (?,?,?,?)");
      rows.forEach((r, i) => {
        const cust = parseCustodian(r.custodian);
        if (!cust) return; // stays in raw; surfaced as nothing mapped -> unknown_rep_code downstream
        const name = r.advisor_name.trim();
        insA.run(name);
        const a = getA.get(name) as { id: number };
        ins.run(cust, r.rep_code.trim().toUpperCase(), a.id, rawIds[i]);
      });
      break;
    }
    case "sf_households": {
      const insA = db.prepare("INSERT OR IGNORE INTO advisors(name) VALUES (?)");
      const getA = db.prepare("SELECT id FROM advisors WHERE name = ?");
      const ins = db.prepare("INSERT OR REPLACE INTO households(sf_id,name,primary_advisor_name,advisor_id,primary_email,created_date,raw_row_id) VALUES (?,?,?,?,?,?,?)");
      rows.forEach((r, i) => {
        const adv = r.Primary_Advisor__c.trim();
        let advId: number | null = null;
        if (adv) { insA.run(adv); advId = (getA.get(adv) as { id: number }).id; }
        ins.run(r.Id, r.Name, adv || null, advId, r.Primary_Email__c.trim().toLowerCase() || null, parseDate(r.CreatedDate, "iso"), rawIds[i]);
      });
      break;
    }
    case "sf_financial_accounts": {
      const ins = db.prepare("INSERT OR REPLACE INTO sf_financial_accounts(sf_id,household_sf_id,account_number_raw,account_key,custodian_raw,custodian,registration_raw,registration,status,notes,raw_row_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      rows.forEach((r, i) =>
        ins.run(r.Id, r.Household__c, r.Account_Number__c, normalizeAccountNumber(r.Account_Number__c), r.Custodian__c, parseCustodian(r.Custodian__c),
          r.Registration_Type__c, normalizeRegistration(r.Registration_Type__c), r.Status__c.trim() || null, r.Notes__c || null, rawIds[i]));
      break;
    }
    case "fidelity":
    case "schwab": {
      const ins = db.prepare("INSERT INTO custodian_observations(custodian,raw_row_id,account_number_raw,account_key,valuation_date,balance_cents,balance_raw,registration_raw,registration,owner_display,owner_name_key,rep_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
      rows.forEach((r, i) => {
        const f = type === "fidelity";
        const acct = f ? r["Acct Number"] : r.account_id;
        const balRaw = f ? r["Market Value"] : r.total_value;
        const money = parseMoneyToCents(balRaw);
        const reg = f ? r.Registration : r.account_type;
        const owner = f ? custodianOwnerDisplay(r["Primary Owner"], r["Joint Owner"]) : r.account_title.trim();
        const ownerRaw = f ? r["Primary Owner"] : r.account_title;
        ins.run(f ? "Fidelity" : "Schwab", rawIds[i], acct, normalizeAccountNumber(acct),
          f ? parseDate(r["As Of"], "mdy") : parseDate(r.value_date, "iso"),
          money.kind === "ok" ? money.cents : null, balRaw, reg, normalizeRegistration(reg), owner, ownerNameKey(ownerRaw),
          ((f ? r["Rep Code"] : r.advisor_code).trim().toUpperCase()) || null);
      });
      break;
    }
  }
}
