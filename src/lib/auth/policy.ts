// Pure authorization policy. Enforced on the server for every read and write.
import type { User } from "./session";
import type { Result } from "../reconciliation/reconcile";

/** Advisors see results tied to their own households; unlinked custodian accounts are visible to the custodian-mapped advisor. */
export function canView(user: User, r: Pick<Result, "sfAdvisor" | "householdId" | "custodianAdvisor">): boolean {
  if (user.role === "operations") return true;
  if (r.householdId) return r.sfAdvisor === user.advisorName;
  return r.custodianAdvisor === user.advisorName;
}

export const canApprove = (user: User) => user.role === "operations";
