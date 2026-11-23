import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { COOKIE, currentUser, getDb, loadResults } from "./server-util";
import { canApprove, canView } from "../lib/auth/policy";
import { computeAum, fmtMoney } from "../lib/reconciliation/aum";
import { decide, propose } from "../lib/workflow/changes";
import { explain } from "../lib/ai/explain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function logout() {
  "use server";
  (await cookies()).delete(COOKIE);
  redirect("/login");
}
async function proposeLink(formData: FormData) {
  "use server";
  const user = await currentUser();
  if (!user) redirect("/login");
  const { results } = loadResults();
  propose(getDb(), user, { kind: "link_account_to_household", entityKey: String(formData.get("entityKey")), householdId: String(formData.get("householdId")) }, String(formData.get("reason") ?? ""), results);
  revalidatePath("/");
}
async function proposeMerge(formData: FormData) {
  "use server";
  const user = await currentUser();
  if (!user) redirect("/login");
  const { results } = loadResults();
  propose(getDb(), user, { kind: "merge_households", fromId: String(formData.get("fromId")), toId: String(formData.get("toId")) }, String(formData.get("reason") ?? ""), results);
  revalidatePath("/");
}
async function decideAction(formData: FormData) {
  "use server";
  const user = await currentUser();
  if (!user) redirect("/login");
  decide(getDb(), user, Number(formData.get("id")), String(formData.get("action")) as "approve" | "reject" | "undo");
  revalidatePath("/");
}

export default async function Home({ searchParams }: { searchParams: Promise<{ explain?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { hasData, results } = loadResults();
  if (!hasData) return <p>No data ingested yet. Run <code>npm run ingest</code> first.</p>;
  const db = getDb();
  const visible = results.filter((r) => canView(user, r));
  const withExc = visible.filter((r) => r.exceptions.length);
  const aum = computeAum(visible);
  const households = (db.prepare("SELECT sf_id, name, primary_advisor_name a FROM households ORDER BY name").all() as any[]).filter((h) => user.role === "operations" || h.a === user.advisorName);
  const changes = (db.prepare("SELECT * FROM proposed_changes ORDER BY id DESC").all() as any[]).filter((c) => user.role === "operations" || c.proposed_by === user.id);
  const audit = user.role === "operations" ? (db.prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT 30").all() as any[]) : [];
  const sp = await searchParams;
  let explained: Awaited<ReturnType<typeof explain>> | null = null;
  if (sp.explain) {
    const [key, code] = sp.explain.split("::");
    const r = visible.find((x) => x.entityKey === key); // visibility enforced: advisors cannot explain others' rows
    if (r) explained = await explain(r, code);
  }

  return (
    <main>
      <p>Signed in as <b>{user.name}</b> ({user.role}) <form action={logout} style={{ display: "inline" }}><button>Sign out</button></form></p>
      <h1>Exceptions</h1>
      <div className="warn"><b>{aum.label}</b><br />
        Grand total ({user.role === "advisor" ? "your accounts" : "all"}): <b>{fmtMoney(aum.grandTotalCents)}</b>.
        {" "}Custodian snapshots: {Object.entries(aum.byCustodian).map(([c, v]) => `${c} ${v.snapshotDate}`).join(", ")}.
        {" "}Counted {aum.coverage.included} accounts; excluded {aum.coverage.excluded}.
        {" "}Possible transfer overlap exposure (not adjusted): {fmtMoney(aum.unresolved.transferOverlapExposureCents)}.
      </div>
      {explained && (
        <div className="warn"><b>AI explanation</b> (provider {explained.provider}, schema-validated: {String(explained.validated)}; advisory only, never auto-applied)
          <pre>{JSON.stringify(explained.explanation, null, 2)}</pre>
          <b>Exactly what was sent to the model:</b><pre>{JSON.stringify(explained.sent, null, 2)}</pre></div>
      )}
      <table>
        <thead><tr><th>Account</th><th>Status</th><th>Balance</th><th>Advisors (custodian / SF)</th><th>Exceptions</th><th>Lineage</th></tr></thead>
        <tbody>
          {withExc.map((r) => (
            <tr key={r.entityKey}>
              <td>{r.custodian} {r.accountKey}<br /><small>{r.ownerDisplay}</small></td>
              <td>{r.status}</td>
              <td>{r.balanceCents == null ? "unknown" : fmtMoney(r.balanceCents)}</td>
              <td>{r.custodianAdvisor ?? "-"} / {r.sfAdvisor ?? "-"}</td>
              <td>{r.exceptions.map((e) => (
                <div key={e.code}><span className={`tag ${e.severity}`}>{e.code}</span> {e.reason} <a href={`/?explain=${encodeURIComponent(r.entityKey + "::" + e.code)}`}>explain</a></div>
              ))}</td>
              <td><small>{r.rawRefs.join(", ")}</small></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Propose a fix (local only; nothing is written to Salesforce or custodians)</h2>
      <form action={proposeLink}>
        <b>Link account to household:</b>{" "}
        <select name="entityKey">{withExc.map((r) => <option key={r.entityKey} value={r.entityKey}>{r.custodian} {r.accountKey}</option>)}</select>
        {" → "}<select name="householdId">{households.map((h) => <option key={h.sf_id} value={h.sf_id}>{h.name}</option>)}</select>
        {" "}<input name="reason" placeholder="reason" /> <button>Propose</button>
      </form>
      <form action={proposeMerge} style={{ marginTop: 8 }}>
        <b>Merge households:</b>{" "}
        <select name="fromId">{households.map((h) => <option key={h.sf_id} value={h.sf_id}>{h.name} ({h.sf_id.slice(-6)})</option>)}</select>
        {" into "}<select name="toId">{households.map((h) => <option key={h.sf_id} value={h.sf_id}>{h.name} ({h.sf_id.slice(-6)})</option>)}</select>
        {" "}<input name="reason" placeholder="reason" /> <button>Propose</button>
      </form>

      <h2>Proposed changes</h2>
      <table><thead><tr><th>#</th><th>Kind</th><th>Payload</th><th>Status</th><th>By</th>{canApprove(user) && <th>Action</th>}</tr></thead><tbody>
        {changes.map((c) => (
          <tr key={c.id}><td>{c.id}</td><td>{c.kind}</td><td><small>{c.payload_json}</small></td><td>{c.status}</td><td>{c.proposed_by}</td>
            {canApprove(user) && <td>
              {c.status === "proposed" && <form action={decideAction}><input type="hidden" name="id" value={c.id} /><button name="action" value="approve">Approve</button> <button name="action" value="reject">Reject</button></form>}
              {c.status === "approved" && <form action={decideAction}><input type="hidden" name="id" value={c.id} /><button name="action" value="undo">Undo</button></form>}
            </td>}
          </tr>
        ))}
      </tbody></table>

      {user.role === "operations" && (<>
        <h2>Audit log (append-only)</h2>
        <table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Subject</th><th>Before</th><th>After</th></tr></thead><tbody>
          {audit.map((a) => <tr key={a.id}><td>{a.at}</td><td>{a.actor}</td><td>{a.action}</td><td>{a.subject}</td><td><small>{a.before_json}</small></td><td><small>{a.after_json}</small></td></tr>)}
        </tbody></table>
      </>)}
    </main>
  );
}
