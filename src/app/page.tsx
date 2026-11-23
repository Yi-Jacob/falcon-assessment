import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { COOKIE, currentUser, getDb, loadResults } from "./server-util";
import { canApprove, canView } from "../lib/auth/policy";
import { computeAum, fmtMoney } from "../lib/reconciliation/aum";
import { decide, propose, resolveException } from "../lib/workflow/changes";
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
async function resolveAction(formData: FormData) {
  "use server";
  const user = await currentUser();
  if (!user) redirect("/login");
  const { results } = loadResults();
  const action = String(formData.get("action"));
  if (action !== "resolve" && action !== "reopen") throw new Error("invalid action");
  resolveException(
    getDb(), user,
    String(formData.get("entityKey")), String(formData.get("code")),
    action, String(formData.get("note") ?? ""), results,
  );
  revalidatePath("/");
}

export default async function Home({ searchParams }: { searchParams: Promise<{ explain?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { hasData, results } = loadResults();
  if (!hasData) {
    return (
      <main className="app-shell">
        <div className="panel">
          <div className="panel-body">
            <h1>No data ingested yet</h1>
            <p className="muted">Run <code>npm run ingest</code> first.</p>
          </div>
        </div>
      </main>
    );
  }
  const db = getDb();
  const visible = results.filter((r) => canView(user, r));
  const withExc = visible.filter((r) => r.exceptions.length);
  // AUM follows the custodian rep-code mapping. The exception table follows visibility.
  const aumResults = user.role === "advisor" ? results.filter((r) => r.custodianAdvisor === user.advisorName) : results;
  const aum = computeAum(aumResults);
  const resolutions = new Map(
    (db.prepare("SELECT entity_key, code, status FROM exception_resolutions").all() as any[])
      .map((x) => [`${x.entity_key}::${x.code}`, x.status as "resolved" | "reopened"]),
  );
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
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          <div>
            <span className="brand-name">Falcon Recon</span>
            <span className="brand-sub">Custodian / Salesforce exceptions</span>
          </div>
        </div>
        <div className="user-area">
          <span className="user-chip">
            <span className="user-role">{user.role}</span>
            <span className="user-name">{user.name}</span>
          </span>
          <form action={logout}>
            <button className="btn btn-ghost btn-small">Sign out</button>
          </form>
        </div>
      </header>

      <div className="page-heading">
        <div>
          <p className="eyebrow">Operations workspace</p>
          <h1>Exceptions</h1>
          <p className="lede">Review custodian / Salesforce breaks, inspect lineage, and record local resolutions. Nothing is written back to either system.</p>
        </div>
        <span className="pill">{withExc.length} accounts in view</span>
      </div>

      <section className="stat-grid" aria-label="AUM summary">
        <article className="stat-card stat-primary">
          <span className="stat-label">Grand total</span>
          <strong className="stat-value">{fmtMoney(aum.grandTotalCents)}</strong>
          <span className="stat-meta">{user.role === "advisor" ? "custodian-attributed accounts" : "all accounts"}</span>
        </article>
        <article className="stat-card">
          <span className="stat-label">Accounts counted</span>
          <strong className="stat-value">{aum.coverage.included}</strong>
          <span className="stat-meta">{aum.coverage.excluded} excluded · {aum.coverage.salesforceOnlyNotCounted} Salesforce-only</span>
        </article>
        <article className="stat-card">
          <span className="stat-label">Review queue</span>
          <strong className="stat-value">{withExc.length}</strong>
          <span className="stat-meta">accounts with at least one exception</span>
        </article>
        <article className="stat-card stat-warn">
          <span className="stat-label">Transfer exposure</span>
          <strong className="stat-value">{fmtMoney(aum.unresolved.transferOverlapExposureCents)}</strong>
          <span className="stat-meta">not adjusted · smaller side of {aum.unresolved.transferOverlapAccounts} flagged accounts</span>
        </article>
      </section>

      <div className="context-bar">
        <span className="context-dot" aria-hidden="true" />
        <span><b>{aum.label}</b></span>
        <span>Custodian snapshots: {Object.entries(aum.byCustodian).map(([c, v]) => `${c} ${v.snapshotDate}`).join(" · ")}</span>
        {user.role === "advisor" && <span>The table shows your households; the total uses the custodian rep-code mapping.</span>}
      </div>

      {explained && (
        <section className="panel ai-panel">
          <div className="panel-head">
            <div>
              <h2>AI explanation</h2>
              <p>Provider {explained.provider} · schema-validated: {String(explained.validated)} · advisory only, never auto-applied</p>
            </div>
            <span className="pill">Preview</span>
          </div>
          <div className="ai-grid">
            <div className="ai-block">
              <h3>Output</h3>
              <pre>{JSON.stringify(explained.explanation, null, 2)}</pre>
            </div>
            <div className="ai-block">
              <h3>Exactly what was sent</h3>
              <pre>{JSON.stringify(explained.sent, null, 2)}</pre>
            </div>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Review queue</h2>
            <p>Every result with at least one exception. Severity is shown on each tag.</p>
          </div>
          <span className="pill">{withExc.length} accounts</span>
        </div>
        {withExc.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Status</th>
                  <th scope="col">Balance</th>
                  <th scope="col">Advisors (custodian / SF)</th>
                  <th scope="col">Exceptions</th>
                  <th scope="col">Lineage</th>
                </tr>
              </thead>
              <tbody>
                {withExc.map((r) => (
                  <tr key={r.entityKey}>
                    <td>
                      <div className="account-cell">
                        <span className="account-id">{r.custodian} {r.accountKey}</span>
                        <span className="account-owner">{r.ownerDisplay ?? "—"}</span>
                      </div>
                    </td>
                    <td><span className={`badge status-${r.status}`}>{r.status.replace(/_/g, " ")}</span></td>
                    <td><span className={r.balanceCents != null && r.balanceCents < 0 ? "money negative" : "money"}>{r.balanceCents == null ? "unknown" : fmtMoney(r.balanceCents)}</span></td>
                    <td>
                      <div className="advisor-pair">
                        <span>{r.custodianAdvisor ?? "—"}</span>
                        <span className="advisor-sep">/</span>
                        <span>{r.sfAdvisor ?? "—"}</span>
                      </div>
                    </td>
                    <td>
                      <div className="exception-list">
                        {r.exceptions.map((e) => {
                          const resolutionKey = `${r.entityKey}::${e.code}`;
                          const resolved = resolutions.get(resolutionKey) === "resolved";
                          return (
                            <div key={e.code} className="exception-row">
                              <span className={`badge badge-${e.severity}`}>{e.code.replace(/_/g, " ")}</span>
                              <span className="exception-reason">{e.reason}</span>
                              <span className="exception-actions">
                                <a className="link-button" href={`/?explain=${encodeURIComponent(r.entityKey + "::" + e.code)}`}>Explain</a>
                                {resolved && <span className="badge badge-resolved">resolved</span>}
                                {canApprove(user) && (
                                  <form action={resolveAction} className="inline-form">
                                    <input type="hidden" name="entityKey" value={r.entityKey} />
                                    <input type="hidden" name="code" value={e.code} />
                                    <input name="note" placeholder="note" className="input-note" size={10} />
                                    <button name="action" value={resolved ? "reopen" : "resolve"} className="btn btn-small">{resolved ? "Reopen" : "Resolve"}</button>
                                  </form>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                    <td>
                      <span className="lineage" title={r.rawRefs.join(", ")}>
                        {r.rawRefs[0] ?? "—"}{r.rawRefs.length > 1 ? ` +${r.rawRefs.length - 1} more` : ""}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">No exceptions in view.</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Propose a fix</h2>
            <p>Local only. Nothing is written to Salesforce or custodians; Operations approves or rejects.</p>
          </div>
          <span className="pill">Workflow</span>
        </div>
        <div className="form-stack">
          <form action={proposeLink} className="form-row">
            <label className="field">
              <span>Account</span>
              <select name="entityKey">{withExc.map((r) => <option key={r.entityKey} value={r.entityKey}>{r.custodian} {r.accountKey}</option>)}</select>
            </label>
            <label className="field">
              <span>Household</span>
              <select name="householdId">{households.map((h) => <option key={h.sf_id} value={h.sf_id}>{h.name}</option>)}</select>
            </label>
            <label className="field field-grow">
              <span>Reason</span>
              <input name="reason" placeholder="Why this link is correct" />
            </label>
            <button className="btn btn-primary">Propose link</button>
          </form>
          <form action={proposeMerge} className="form-row">
            <label className="field">
              <span>Merge household</span>
              <select name="fromId">{households.map((h) => <option key={h.sf_id} value={h.sf_id}>{h.name} ({h.sf_id.slice(-6)})</option>)}</select>
            </label>
            <label className="field">
              <span>Into household</span>
              <select name="toId">{households.map((h) => <option key={h.sf_id} value={h.sf_id}>{h.name} ({h.sf_id.slice(-6)})</option>)}</select>
            </label>
            <label className="field field-grow">
              <span>Reason</span>
              <input name="reason" placeholder="Why these households are duplicates" />
            </label>
            <button className="btn">Propose merge</button>
          </form>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Proposed changes</h2>
            <p>Operations approves, rejects or undoes. Every action is audited.</p>
          </div>
          <span className="pill">{changes.length}</span>
        </div>
        {changes.length ? (
          <div className="table-wrap">
            <table className="data-table compact-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Payload</th>
                  <th scope="col">Status</th>
                  <th scope="col">By</th>
                  {canApprove(user) && <th scope="col">Action</th>}
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td>{c.kind}</td>
                    <td><code className="payload">{c.payload_json}</code></td>
                    <td><span className={`badge badge-${c.status}`}>{c.status}</span></td>
                    <td>{c.proposed_by}</td>
                    {canApprove(user) && (
                      <td>
                        {c.status === "proposed" && (
                          <form action={decideAction} className="inline-form">
                            <input type="hidden" name="id" value={c.id} />
                            <button name="action" value="approve" className="btn btn-small btn-primary">Approve</button>
                            <button name="action" value="reject" className="btn btn-small btn-danger">Reject</button>
                          </form>
                        )}
                        {c.status === "approved" && (
                          <form action={decideAction} className="inline-form">
                            <input type="hidden" name="id" value={c.id} />
                            <button name="action" value="undo" className="btn btn-small">Undo</button>
                          </form>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">No proposed changes yet.</p>
        )}
      </section>

      {user.role === "operations" && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Audit log</h2>
              <p>Append-only. Before/after payloads are shown raw.</p>
            </div>
            <span className="pill">Latest 30</span>
          </div>
          {audit.length ? (
            <div className="table-wrap">
              <table className="data-table compact-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Who</th>
                    <th scope="col">Action</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td>{a.at}</td>
                      <td>{a.actor}</td>
                      <td><span className="badge badge-info">{a.action}</span></td>
                      <td>{a.subject}</td>
                      <td><code className="payload">{a.before_json ?? "—"}</code></td>
                      <td><code className="payload">{a.after_json ?? "—"}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">No audit events yet.</p>
          )}
        </section>
      )}
    </main>
  );
}
