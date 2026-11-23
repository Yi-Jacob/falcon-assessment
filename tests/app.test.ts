import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/db/db";
import { canView } from "../src/lib/auth/policy";
import { SEEDED_USERS, makeCookieValue, readCookieValue } from "../src/lib/auth/session";
import { decide, propose } from "../src/lib/workflow/changes";
import { ExplanationSchema, buildPrompt, explain, type LlmProvider } from "../src/lib/ai/explain";
import type { Result } from "../src/lib/reconciliation/reconcile";

const ops = SEEDED_USERS[0], dana = SEEDED_USERS[1];
const res = (o: Partial<Result>): Result => ({ entityKey: "Fidelity|Z1", custodian: "Fidelity", accountKey: "Z1234", status: "matched", balanceCents: 1, inAum: true, valuationDate: "2026-11-06", repCode: "WF7",
  custodianAdvisor: "Dana Whitfield", sfAdvisor: "Dana Whitfield", householdId: "h1", sfAccountIds: [], observationIds: [1], rawRefs: [], ownerDisplay: "X", exceptions: [{ code: "advisor_mismatch", severity: "review", reason: "r" }], ...o });

function seed() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO advisors(name) VALUES ('Dana Whitfield'),('Marcus Lee')").run();
  const b = db.prepare("INSERT INTO import_batches(started_at) VALUES ('t')").run().lastInsertRowid;
  const f = db.prepare("INSERT INTO raw_files(batch_id,source_type,filename,sha256,byte_size,content,ingested_at) VALUES (?,?,?,?,?,?,?)").run(b, "sf_households", "f", "x", 1, Buffer.from("x"), "t").lastInsertRowid;
  const r = db.prepare("INSERT INTO raw_rows(file_id,row_number,values_json) VALUES (?,?,?)").run(f, 1, "{}").lastInsertRowid;
  const h = db.prepare("INSERT INTO households(sf_id,name,primary_advisor_name,raw_row_id) VALUES (?,?,?,?)");
  h.run("h1", "H1", "Dana Whitfield", r); h.run("h2", "H2", "Dana Whitfield", r); h.run("h3", "H3", "Marcus Lee", r);
  return db;
}

describe("authorization", () => {
  it("advisors only see their own households; ops sees all", () => {
    expect(canView(dana, res({}))).toBe(true);
    expect(canView(dana, res({ sfAdvisor: "Marcus Lee" }))).toBe(false);
    expect(canView(ops, res({ sfAdvisor: "Marcus Lee" }))).toBe(true);
  });
  it("rejects forged or unsigned cookies", () => {
    expect(readCookieValue(makeCookieValue("ops"))?.role).toBe("operations");
    expect(readCookieValue("ops.deadbeef")).toBeNull();
    expect(readCookieValue("ops")).toBeNull();
  });
  it("advisors cannot approve; ops approve/undo with before/after audit", () => {
    const db = seed();
    const id = propose(db, dana, { kind: "merge_households", fromId: "h1", toId: "h2" }, "dupe", [res({})]);
    expect(() => decide(db, dana, id, "approve")).toThrow(/forbidden/);
    decide(db, ops, id, "approve");
    expect((db.prepare("SELECT active FROM approved_overrides").get() as any).active).toBe(1);
    decide(db, ops, id, "undo");
    expect((db.prepare("SELECT active FROM approved_overrides").get() as any).active).toBe(0);
    const log = db.prepare("SELECT action, before_json, after_json FROM audit_events ORDER BY id").all() as any[];
    expect(log.map((l) => l.action)).toEqual(["propose", "approve", "undo"]);
    expect(JSON.parse(log[2].before_json).status).toBe("approved");
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
  });
  it("advisor cannot propose against another advisor's household", () => {
    const db = seed();
    expect(() => propose(db, dana, { kind: "merge_households", fromId: "h1", toId: "h3" }, "", [res({})])).toThrow(/forbidden/);
  });
});

describe("AI feature", () => {
  it("prompt never includes tax ids, emails or notes and masks the account number", () => {
    const p = buildPrompt(res({}), "advisor_mismatch");
    expect(p.user).toContain("****1234");
    expect(p.user).not.toContain("Z1234");
  });
  it("treats model output as untrusted", async () => {
    const evil: LlmProvider = { name: "evil", complete: async () => ({ summary: "ok", suggestedAction: "approve_everything", confidence: "high" }) };
    const out = await explain(res({}), "advisor_mismatch", evil, () => {});
    expect(out.validated).toBe(false);
    expect(ExplanationSchema.safeParse(out.explanation).success).toBe(true);
    expect(out.explanation.suggestedAction).toBe("manual_review");
  });
});
