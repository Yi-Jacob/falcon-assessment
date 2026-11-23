import { cookies } from "next/headers";
import { openDb, type Db } from "../lib/db/db";
import { readCookieValue, type User } from "../lib/auth/session";
import { reconcile } from "../lib/reconciliation/reconcile";
import { loadInput, runReconciliation } from "../lib/reconciliation/run";

export const COOKIE = "falcon_session";
let _db: Db | null = null;
export const getDb = () => (_db ??= openDb());

export async function currentUser(): Promise<User | null> {
  return readCookieValue((await cookies()).get(COOKIE)?.value);
}

export function loadResults() {
  const db = getDb();
  const hasData = (db.prepare("SELECT COUNT(*) c FROM raw_files").get() as { c: number }).c > 0;
  if (!hasData) return { hasData, results: [], runId: null as number | null };
  const { runId, results } = runReconciliation(db);
  return { hasData, results, runId };
}
export { reconcile, loadInput };
