import { z } from "zod";
import type { Db } from "../db/db";
import { canApprove, canView } from "../auth/policy";
import type { User } from "../auth/session";
import type { Result } from "../reconciliation/reconcile";

export const ProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("link_account_to_household"), entityKey: z.string().min(1), householdId: z.string().min(1) }),
  z.object({ kind: z.literal("merge_households"), fromId: z.string().min(1), toId: z.string().min(1) }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

const audit = (db: Db, at: string, actor: string, action: string, subject: string, before: unknown, after: unknown) =>
  db.prepare("INSERT INTO audit_events(at,actor,action,subject,before_json,after_json) VALUES (?,?,?,?,?,?)").run(at, actor, action, subject, JSON.stringify(before), JSON.stringify(after));

export function propose(db: Db, user: User, raw: unknown, reason: string, results: Result[], now = new Date().toISOString()): number {
  const p = ProposalSchema.parse(raw);
  const hhOwner = (id: string) => (db.prepare("SELECT primary_advisor_name a FROM households WHERE sf_id=?").get(id) as { a: string | null } | undefined);
  if (p.kind === "link_account_to_household") {
    const r = results.find((x) => x.entityKey === p.entityKey);
    if (!r || !canView(user, r)) throw new Error("forbidden");
    if (!hhOwner(p.householdId)) throw new Error("unknown household");
    if (user.role === "advisor" && hhOwner(p.householdId)!.a !== user.advisorName) throw new Error("forbidden");
  } else {
    if (p.fromId === p.toId) throw new Error("cannot merge a household into itself");
    const a = hhOwner(p.fromId), b = hhOwner(p.toId);
    if (!a || !b) throw new Error("unknown household");
    if (user.role === "advisor" && (a.a !== user.advisorName || b.a !== user.advisorName)) throw new Error("forbidden");
  }
  return db.transaction(() => {
    const id = Number(db.prepare("INSERT INTO proposed_changes(kind,payload_json,reason,status,proposed_by,proposed_at) VALUES (?,?,?,'proposed',?,?)").run(p.kind, JSON.stringify(p), reason.slice(0, 500), user.id, now).lastInsertRowid);
    audit(db, now, user.id, "propose", `change:${id}`, null, { status: "proposed", ...p });
    return id;
  })();
}

export type ResolutionAction = "resolve" | "reopen";

/** Local exception resolution state. Never writes back to Salesforce or a custodian. */
export function resolveException(
  db: Db, user: User, entityKey: string, code: string, action: ResolutionAction, note: string, results: Result[], now = new Date().toISOString(),
) {
  if (!canApprove(user)) throw new Error("forbidden");
  const result = results.find((r) => r.entityKey === entityKey);
  if (!result || !result.exceptions.some((e) => e.code === code)) throw new Error("unknown exception");
  if (action !== "resolve" && action !== "reopen") throw new Error("invalid action");
  const status = action === "resolve" ? "resolved" : "reopened";
  const safeNote = note.slice(0, 500);
  db.transaction(() => {
    const before = db.prepare("SELECT status, note FROM exception_resolutions WHERE entity_key=? AND code=?").get(entityKey, code) ?? null;
    db.prepare(`
      INSERT INTO exception_resolutions(entity_key,code,status,actor,at,note) VALUES (?,?,?,?,?,?)
      ON CONFLICT(entity_key,code) DO UPDATE SET status=excluded.status, actor=excluded.actor, at=excluded.at, note=excluded.note
    `).run(entityKey, code, status, user.id, now, safeNote);
    audit(db, now, user.id, action, `exception:${entityKey}:${code}`, before, { status, note: safeNote });
  })();
}

export function decide(db: Db, user: User, changeId: number, action: "approve" | "reject" | "undo", now = new Date().toISOString()) {
  if (!canApprove(user)) throw new Error("forbidden");
  db.transaction(() => {
    const c = db.prepare("SELECT * FROM proposed_changes WHERE id=?").get(changeId) as any;
    if (!c) throw new Error("not found");
    const allowed = { approve: "proposed", reject: "proposed", undo: "approved" }[action];
    if (c.status !== allowed) throw new Error(`cannot ${action} a change that is ${c.status}`);
    const next = { approve: "approved", reject: "rejected", undo: "undone" }[action];
    db.prepare("UPDATE proposed_changes SET status=?, decided_by=?, decided_at=? WHERE id=?").run(next, user.id, now, changeId);
    if (action === "approve") db.prepare("INSERT INTO approved_overrides(change_id,kind,payload_json,active) VALUES (?,?,?,1)").run(changeId, c.kind, c.payload_json);
    if (action === "undo") db.prepare("UPDATE approved_overrides SET active=0 WHERE change_id=?").run(changeId);
    audit(db, now, user.id, action, `change:${changeId}`, { status: c.status, active: c.status === "approved" }, { status: next, active: action === "approve", payload: JSON.parse(c.payload_json) });
  })();
}
