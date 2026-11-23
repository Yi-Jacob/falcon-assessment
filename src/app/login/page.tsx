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
    <main>
      <h1>Sign in (mock)</h1>
      <p className="warn">Mock authentication for the exercise: pick a seeded user. Roles are enforced on the server; this is not production identity verification.</p>
      <form action={signIn}>
        {SEEDED_USERS.map((u) => (
          <div key={u.id}><label><input type="radio" name="user" value={u.id} defaultChecked={u.id === "ops"} /> {u.name}</label></div>
        ))}
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
