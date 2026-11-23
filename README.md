# Falcon reconciliation take-home

Ingests the Fidelity, Schwab, Salesforce household/account and rep-code files, reconciles them, reports AUM, and offers a small exceptions UI.

**Start:** 2026-11-22 16:04:25 PST (recorded when the task began).
**End:** _fill in when you finish._ The agent's own tool timestamps show the build ran about 10 minutes of wall clock, ending around 16:15. That is agent time, not your 2-hour budget; you should still review, run and adjust it yourself.

## Run it

```bash
npm install
npm run ingest      # loads data/*.csv into falcon.db (safe to re-run: identical files are skipped)
npm run report      # AUM + every exception, as markdown
npm test            # 19 tests
npm run build && FALCON_DB=$PWD/falcon.db npx next start -p 3111   # or `npm run dev`
```

The app is at <http://localhost:3111>. It uses mock sign-in with seeded users: Operations plus one user per advisor. No API key is needed. The default AI provider is an offline mock.

Always run the app from the repo root, or set `FALCON_DB` to an absolute path. Otherwise SQLite creates an empty DB in whatever folder you started from. This happened to me once during development.

## Data model (`src/lib/db/schema.ts`)

| Layer | Tables | Grain / key |
|---|---|---|
| Raw (immutable, trigger-protected) | `raw_files`, `raw_rows`, `import_batches` | file = SHA-256 (unique, original bytes in a BLOB); row = (file, row number), values stored as unmodified strings |
| Canonical facts | `advisors`, `rep_code_map`, `households`, `sf_financial_accounts`, `custodian_observations` | rep code = (custodian, code). Account identity = (custodian, normalized account number). An observation = one custodian source row with its valuation date and raw-row lineage. Fidelity and Schwab share one table. |
| Derived (rebuildable) | `recon_runs`, `recon_results`, `recon_exceptions` | one result per account entity (or per invalid-identity source row) per run; exceptions are independent of status |
| Local workflow | `users`, `proposed_changes`, `approved_overrides`, `audit_events` | audit is append-only (trigger-enforced), with before/after JSON |

Tax IDs and SSN fragments stay in the raw layer only. They are never copied to canonical tables, never used for matching, and never sent to the AI.

Pure logic lives apart from the DB and UI: `ingest/normalize.ts`, `reconciliation/reconcile.ts`, `reconciliation/aum.ts` and `auth/policy.ts`.

**Idempotency:** re-importing identical bytes is a no-op (SHA-256 unique). Reconciliation runs are keyed by an input fingerprint and reused when nothing changed. A test checks that totals do not move.

## Status categories (one per account)

- `matched`: custodian observation and exactly one Salesforce account share custodian + normalized number.
- `custodian_only`: at the custodian, not in Salesforce. Still counted in AUM if the balance is valid.
- `salesforce_only`: in Salesforce, not in the custodian file. Never added to AUM.
- `ambiguous`: several Salesforce records share one custodian + number.
- `invalid_identity`: empty or malformed account number or custodian. Nothing in the supplied data triggers this, but it is implemented and tested for.

Exception codes are separate and stack on any status. They are: `exact_duplicate`, `conflicting_duplicate`, `missing_balance`, `negative_balance`, `unknown_rep_code`, `advisor_mismatch`, `registration_mismatch`, `unknown_registration`, `possible_account_number_typo`, `custodian_mismatch_candidate`, `possible_duplicate_household`, `mixed_valuation_dates`, `possible_transfer_overlap`, `status_conflict`, `not_in_salesforce`, `not_at_custodian`, `duplicate_salesforce_account`, `orphan_household_link`, `superseded_observation`, `suspicious_note_content`.

## AUM (computed from the files; `npm run report` regenerates it)

**Mixed-date, latest-available reported balances. This is not a synchronized point-in-time total, and it is not transfer-adjusted.**

| Custodian | Row as-of date | Accounts counted | Balance |
|---|---|---|---|
| Fidelity | 2026-11-06 | 43 | $46,468,120.77 |
| Schwab | 2026-10-30 | 20 | $22,517,796.57 |
| **Grand total** | mixed | 63 | **$68,985,917.34** |

I checked the total independently with a separate Python script that reads the raw CSVs. It matched.

| Advisor (custodian rep-code mapping) | Accounts | Balance |
|---|---|---|
| Dana Whitfield | 17 | $17,084,275.44 |
| Marcus Lee | 16 | $15,662,603.12 |
| Priya Nair | 14 | $15,045,373.06 |
| Tom Alvarez | 15 | $18,787,229.80 |
| Unassigned (unknown Schwab code `RX99`) | 1 | $2,406,435.92 |

**Coverage:**
- 64 distinct custodian accounts.
- 63 counted. 1 excluded for a blank balance.
- 4 Salesforce-only accounts not counted.
- 1 exact duplicate collapsed (the Fidelity file repeats one row).
- 1 negative balance included (−$12,500.00).
- 5 custodian-only accounts included, with valid balances.

**Unresolved exposure, not adjusted:** 2 accounts, $4,409,175.42, flagged `possible_transfer_overlap`. A Schwab trust account is marked "Transferring" in Salesforce with an ACAT-to-Fidelity note. A custodian-only Fidelity trust account has the same owner name, registration and a balance within 10%. It may be a double count. I did not remove anything, because a note is not proof.

**Advisor disagreement with Salesforce:** 1 account, $191,998.40. It is attributed to the custodian advisor and shown separately.

Status counts: 59 matched, 5 custodian-only, 4 Salesforce-only. There are 26 exception rows in total.

## Judgment calls

1. **Custodian is the valuation source.** Salesforce decides links and household ownership only.
2. **Latest snapshot per custodian**, with dates parsed from the rows rather than the filenames. Both agree here. The two custodians are 7 days apart, so the combined total is labelled mixed-date.
3. **Account numbers:** only hyphens and spaces are removed, and letters and leading zeros are kept. Schwab `08855469` versus Salesforce `8855469` is *not* matched. Both sides get `possible_account_number_typo` and go to a human.
4. **Salesforce `Z76734738` is labelled Schwab, but that number exists at Fidelity.** It is flagged `custodian_mismatch_candidate` on both sides and not linked. The Fidelity balance counts as custodian-only.
5. **Registrations** go through the table in `normalize.ts` (see MAPPING.md). Salesforce "IRA" is coarser than "Roth IRA" or "SEP IRA", so it is compatible with any IRA subtype. Schwab "Contributory IRA" is treated as traditional. Confirm that with Operations.
6. **Blank balance is unknown, not zero.** It is excluded from sums and reported. Negative balances are kept in the net total and flagged.
7. **Exact duplicates** count once with all lineage kept. **Conflicting same-date duplicates** are excluded with no winner picked. The data has none, but there is a unit test.
8. **Unknown rep codes** go to "Unassigned". They never borrow the Salesforce advisor.
9. **Duplicate-household signals** (shared email or a shared full client name) are review-only. The Mbeki and Oyelaran households are flagged. Nothing is merged automatically.
10. **Closed Salesforce account missing from the custodian** is `info`, because that is expected. An open one missing is `review`.
11. **Advisor visibility:** an advisor sees accounts whose Salesforce household belongs to them. Unlinked custodian accounts are visible to the advisor their custodian rep code maps to.
12. **Prompt injection:** one Salesforce note contains instruction-like text addressed to an AI. It is treated purely as data, flagged `suspicious_note_content`, and kept out of every prompt. The AI sees only structured, minimised facts.
13. **Approvals** are stored as local `approved_overrides`. They are not yet re-applied to reconciliation output. See "Next".

## Auth and AI

- **Mock auth:** an HMAC-signed, HTTP-only cookie holding a seeded user id. Policy is checked in the server pages and actions (`auth/policy.ts`, `workflow/changes.ts`).
  - Advisors cannot approve, cannot view other advisors' rows, and cannot propose against other advisors' households.
  - Operations approve, reject and undo. Every action writes a before/after audit row.
  - Set `SESSION_SECRET` outside local dev.
- **AI "Explain":** the default is the offline `mockProvider`, behind the `LlmProvider` interface. The page shows the exact prompt that would be sent, and the server logs it. Output is validated with Zod and replaced by a safe fallback if invalid. It is advisory only and never auto-applied. No real model was wired up.

## Verification actually done

- `npm test`: 19 tests passed (normalization, duplicate handling, matching candidates, AUM rules, idempotent ingest, immutability, authorization, audit and undo, AI output validation).
- `tsc --noEmit` and `next build` are clean.
- HTTP smoke test (`scripts/smoke.py`): Operations saw 26 exception rows and the audit log. Dana saw 6 and no audit log. A forged cookie was redirected to login.
- Not done: no real browser or visual check, and I did not click through propose, approve and undo in the UI. That flow is covered by unit tests only.

## Next, with more time

- Apply approved overrides inside the reconciliation, so links and merges change results, with a re-run diff.
- Tests for the Next server actions and a browser test.
- A per-exception resolution state, with notes.
- Fuzzy typo candidates beyond leading zeros (transpositions).
- Per-row valuation dates when a file mixes dates, and history across daily files.
- Real session or SSO, CSRF review, and a real LLM provider behind the existing interface with redaction tests.
- Confirm with Operations the Schwab "Contributory IRA" mapping and the transfer-tolerance heuristic (10%).
