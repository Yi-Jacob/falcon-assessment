// Pure normalization helpers. No I/O. Every function treats input as untrusted data.

export type Custodian = "Fidelity" | "Schwab";

export function parseCustodian(raw: string): Custodian | null {
  const v = raw.trim().toLowerCase();
  if (v === "fidelity") return "Fidelity";
  if (v === "schwab") return "Schwab";
  return null;
}

/**
 * Conservative account-number normalization.
 * - trim, uppercase
 * - remove ONLY documented separators: hyphen and whitespace
 * - never pad, never strip letters or leading zeros
 * Returns null if the result is empty or contains anything other than A-Z/0-9.
 */
export function normalizeAccountNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const k = raw.trim().toUpperCase().replace(/[-\s]/g, "");
  if (k === "" || !/^[A-Z0-9]+$/.test(k)) return null;
  return k;
}

export type MoneyParse =
  | { kind: "ok"; cents: number }
  | { kind: "blank" }
  | { kind: "invalid"; raw: string };

/** Parse a money string to integer cents using string math (no floats). Blank is unknown, not zero. */
export function parseMoneyToCents(raw: string | null | undefined): MoneyParse {
  const s = (raw ?? "").trim();
  if (s === "") return { kind: "blank" };
  const m = /^(-|\()?\s*(-)?\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\)?$/.exec(s);
  if (!m) return { kind: "invalid", raw: s };
  const negative = !!m[1] || !!m[2];
  if (m[1] === "(" && !s.endsWith(")")) return { kind: "invalid", raw: s };
  const whole = m[3].replace(/,/g, "");
  const frac = (m[4] ?? "").padEnd(2, "0");
  const cents = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(cents)) return { kind: "invalid", raw: s };
  return { kind: "ok", cents: negative ? -cents : cents };
}

function validIso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Explicit formats only: YYYY-MM-DD (Schwab/Salesforce) and MM/DD/YYYY (Fidelity). Returns ISO date or null. */
export function parseDate(raw: string | null | undefined, format: "iso" | "mdy"): string | null {
  const s = (raw ?? "").trim();
  if (format === "iso") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? validIso(+m[1], +m[2], +m[3]) : null;
  }
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  return m ? validIso(+m[3], +m[1], +m[2]) : null;
}

// ---- Registration mapping (documented in README / MAPPING.md) ----
export type Registration =
  | "individual"
  | "joint"
  | "trust"
  | "ira_traditional"
  | "ira_roth"
  | "ira_sep"
  | "ira_unspecified" // Salesforce "IRA" is coarser than custodian labels
  | "unknown";

export const REGISTRATION_MAP: Record<string, Registration> = {
  // Fidelity
  "INDIVIDUAL": "individual",
  "INDV": "individual",
  "JTWROS": "joint",
  "JT TEN WROS": "joint",
  "TRUST-REVOCABLE": "trust",
  "REV TRUST": "trust",
  "IRA-TRADITIONAL": "ira_traditional",
  "TRAD IRA": "ira_traditional",
  "ROTH IRA": "ira_roth",
  "ROTH": "ira_roth",
  "SEP IRA": "ira_sep",
  "SEP": "ira_sep",
  // Schwab
  "JOINT TENANTS WROS": "joint",
  "LIVING TRUST": "trust",
  "CONTRIBUTORY IRA": "ira_traditional",
  "IRA - TRADITIONAL": "ira_traditional",
  "ROTH CONTRIBUTORY IRA": "ira_roth",
  // Salesforce
  "JOINT": "joint",
  "TRUST": "trust",
  "IRA": "ira_unspecified",
};

export function normalizeRegistration(raw: string | null | undefined): Registration {
  const k = (raw ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return REGISTRATION_MAP[k] ?? "unknown";
}

const isIra = (r: Registration) => r.startsWith("ira_");

/** True when two known registrations disagree. ira_unspecified is compatible with any IRA subtype. */
export function registrationsConflict(a: Registration, b: Registration): boolean {
  if (a === "unknown" || b === "unknown") return false; // reported separately as unknown_registration
  if (a === b) return false;
  if (isIra(a) && isIra(b) && (a === "ira_unspecified" || b === "ira_unspecified")) return false;
  return true;
}

// ---- Owner names (review signals only; never used to auto-link) ----
const TITLE_SUFFIX = /\b(JT TEN|JTWROS|JT|TRUST|IRA|ROTH)\b.*$/i;

/** "ROSENTHAL, THOMAS" -> "thomas rosenthal"; "Linda Barrow & Deborah Barrow JT TEN" -> "linda barrow". */
export function ownerNameKey(raw: string): string {
  let s = raw.trim();
  if (s.includes(",")) {
    const [last, first] = s.split(",", 2).map((x) => x.trim());
    s = `${first} ${last}`;
  } else {
    s = s.split("&")[0].replace(TITLE_SUFFIX, "");
  }
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function custodianOwnerDisplay(primary: string, joint: string): string {
  const p = primary.trim();
  const j = joint.trim();
  return j ? `${p} / ${j}` : p;
}

/** Person names embedded in a household name, e.g. "A & B Last Household" -> ["a last","b last"]. */
export function householdPersonKeys(name: string): string[] {
  const base = name.replace(/\s+Household\s*$/i, "").trim();
  const parts = base.split(/\s*&\s*/);
  const last = parts[parts.length - 1].split(/\s+/).slice(-1)[0];
  return parts.map((p, i) => {
    const toks = p.trim().split(/\s+/);
    const full = i === parts.length - 1 ? toks : [...toks, last];
    return full.join(" ").toLowerCase();
  });
}

export const SUSPICIOUS_NOTE = /(ignore (all )?(previous|prior)|system note|assistant|mark (every|all)|do not mention)/i;
export const TRANSFER_NOTE = /\b(ACAT|transfer(ring)?)\b/i;
