import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE } from "../server-util";
import { SEEDED_USERS, makeCookieValue } from "../../lib/auth/session";

export const runtime = "nodejs";

async function signIn(formData: FormData) {
  "use server";
  const id = String(formData.get("user"));
  if (!SEEDED_USERS.some((u) => u.id === id)) redirect("/login");
  (await cookies()).set(COOKIE, makeCookieValue(id), { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.COOKIE_SECURE === "1" });
  redirect("/");
}

export default function Login() {
  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          <div>
            <span className="brand-name">Falcon Recon</span>
            <span className="brand-sub">Operations demo</span>
          </div>
        </div>
        <h1>Sign in</h1>
        <p className="lede">Mock authentication for the exercise. Pick a seeded user. Roles are enforced on the server.</p>
        <form action={signIn} className="login-form">
          <div className="role-grid">
            {SEEDED_USERS.map((u) => (
              <label key={u.id} className="role-option">
                <input type="radio" name="user" value={u.id} defaultChecked={u.id === "ops"} />
                <span className="role-avatar" aria-hidden="true">{u.name.slice(0, 1)}</span>
                <span className="role-copy">
                  <span className="role-name">{u.name}</span>
                  <span className="role-meta">{u.role}{u.advisorName ? ` · ${u.advisorName}` : ""}</span>
                </span>
              </label>
            ))}
          </div>
          <button className="btn btn-primary btn-block">Continue</button>
        </form>
        <p className="login-note">This is not production identity verification. The demo uses HMAC-signed, HTTP-only cookies and server-side role checks.</p>
      </section>
    </main>
  );
}
