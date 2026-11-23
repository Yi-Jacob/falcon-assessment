// MOCK authentication: seeded users + HMAC-signed HTTP-only cookie. Not production identity verification.
import { createHmac, timingSafeEqual } from "node:crypto";

export type Role = "operations" | "advisor";
export interface User { id: string; name: string; role: Role; advisorName: string | null }

export const SEEDED_USERS: User[] = [
  { id: "ops", name: "Olivia (Operations)", role: "operations", advisorName: null },
  { id: "dana", name: "Dana Whitfield (Advisor)", role: "advisor", advisorName: "Dana Whitfield" },
  { id: "marcus", name: "Marcus Lee (Advisor)", role: "advisor", advisorName: "Marcus Lee" },
  { id: "priya", name: "Priya Nair (Advisor)", role: "advisor", advisorName: "Priya Nair" },
  { id: "tom", name: "Tom Alvarez (Advisor)", role: "advisor", advisorName: "Tom Alvarez" },
];

const secret = () => process.env.SESSION_SECRET ?? "dev-only-mock-secret-change-me";
const sign = (v: string) => createHmac("sha256", secret()).update(v).digest("hex");

export function makeCookieValue(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

/** Returns the seeded user only if the signature verifies. */
export function readCookieValue(v: string | undefined): User | null {
  if (!v) return null;
  const i = v.lastIndexOf(".");
  if (i < 0) return null;
  const id = v.slice(0, i);
  const given = Buffer.from(v.slice(i + 1));
  const want = Buffer.from(sign(id));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return SEEDED_USERS.find((u) => u.id === id) ?? null;
}
