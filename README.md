# Falcon reconciliation take-home

Ingests the Fidelity, Schwab, Salesforce household/account and rep-code files, reconciles them, reports AUM, and offers a small exceptions UI. A short Word submission summary is included as `Falcon_Submission.docx`.

**Start:** 2026-11-22 16:04:25 PST
**End:** 2026-11-22 17:21:25 PST
**Duration:** 1 hour 17 minutes

Built with Claude Code; `AI_NOTES.md` records the tools, prompts and corrections, including the review/fix pass.

## Run it

```bash
npm install
npm run ingest      # loads data/*.csv into falcon.db (safe to re-run: identical files are skipped)
npm run report      # AUM + every exception, as markdown
npm test            # 26 tests
npm run build && FALCON_DB=$PWD/falcon.db SESSION_SECRET=dev-only-mock-secret-change-me npx next start -p 3111
# or: npm run dev
```

The app is at <http://localhost:3111>. It uses mock sign-in with seeded users: Operations plus one user per advisor. No API key is needed. The default AI provider is an offline mock.

Always run the app from the repo root, or set `FALCON_DB` to an absolute path. Otherwise SQLite creates an empty DB in whatever folder you started from.

Outside the Vercel preview, production refuses to sign a session cookie unless `SESSION_SECRET` is set. The command above uses a local-only value; replace it outside local development. Set `COOKIE_SECURE=1` behind HTTPS.

The Vercel preview is a mock-auth demo: it uses a demo-only cookie fallback and copies `data/falcon-demo.db` to `/tmp/falcon.db` on first use. Set `SESSION_SECRET` in Vercel for a real deployment. Local runs keep using `falcon.db` and `npm run ingest`.

## Data model (`src/lib/db/schema.ts`)

| Layer | Tables | Grain / key |
|---|---|---|
| Raw (immutable, trigger-protected) | `raw_files`, `raw_rows`, `import_batches` | file = SHA-256 (unique, original bytes in a BLOB); row = (file, row number), values stored as unmodified strings |
| Canonical facts | `advisors`, `rep_code_map`, `households`, `sf_financial_accounts`, `custodian_observations` | rep code = (custodian, code). Account identity = (custodian, normalized account number). An observation = one custodian source row with its valuation date and raw-row lineage. Fidelity and Schwab share one table. |
| Derived (rebuildable) | `recon_runs`, `recon_results`, `recon_exceptions` | one result per account entity (or per invalid-identity source row) per run; exceptions are independent of status |
| Local workflow | `exception_resolutions`, `proposed_changes`, `approved_overrides`, `audit_events` | local resolve/reopen state, proposals, overrides, and an append-only audit with before/after JSON |

Mock users are defined in code (`src/lib/auth/session.ts`); there is no DB users table.

Tax IDs and SSN fragments stay in the raw layer only. They are never copied to canonical tables, never used for matching, and never sent to the AI.

Pure logic lives apart from the DB and UI: `ingest/normalize.ts`, `reconciliation/reconcile.ts`, `reconciliation/aum.ts` and `auth/policy.ts`.

**Idempotency:** re-importing identical bytes is a no-op (SHA-256 unique). A no-op import does not create an empty batch. Reconciliation runs are keyed by an input + policy-version fingerprint and reused when neither changed. A test checks that totals do not move.

## Status categories (one per account)

- `matched`: custodian observation and exactly one Salesforce account share custodian + normalized number.
- `custodian_only`: at the custodian, not in Salesforce. Still counted in AUM if the balance is valid.
- `salesforce_only`: in Salesforce, not in the custodian file. Never added to AUM.
- `ambiguous`: several Salesforce records share one custodian + number.
- `invalid_identity`: empty or malformed account number or custodian. Nothing in the supplied data triggers this, but it is implemented and tested for.

Exception codes are separate and stack on any status. They are: `exact_duplicate`, `conflicting_duplicate`, `missing_balance`, `missing_valuation_date`, `negative_balance`, `unknown_rep_code`, `advisor_mismatch`, `registration_mismatch`, `unknown_registration`, `possible_account_number_typo`, `custodian_mismatch_candidate`, `possible_duplicate_household`, `mixed_valuation_dates`, `possible_transfer_overlap`, `status_conflict`, `not_in_salesforce`, `not_at_custodian`, `duplicate_salesforce_account`, `orphan_household_link`, `superseded_observation`, `suspicious_note_content`.

Resolved/reopened is a separate local workflow state, not an exception code.

## AUM (computed from the files; `npm run report` regenerates it)

**Mixed-date, latest-available reported balances. This is not a synchronized point-in-time total, and it is not transfer-adjusted.**

| Custodian | Row as-of date | Accounts counted | Balance |
|---|---|---|---|
| Fidelity | 2026-11-06 | 43 | $46,468,120.77 |
| Schwab | 2026-10-30 | 20 | $22,517,796.57 |
| **Grand total** | mixed | 63 | **$68,985,917.34** |

I checked the total independently with a separate Python script that reads the raw CSVs using `Decimal`. It matched to the cent.

| Advisor (custodian rep-code mapping) | Accounts | Balance |
|---|---|---|
| Dana Whitfield | 17 | $17,084,275.44 |
| Marcus Lee | 16 | $15,662,603.12 |
| Priya Nair | 14 | $15,045,373.06 |
| Tom Alvarez | 15 | $18,787,229.80 |
| Unassigned (unknown Schwab code `RX99`) | 1 | $2,406,435.92 |

The advisor-facing page uses the same custodian attribution for its total. The exception table is scoped by Salesforce household, so an advisor can see a household account whose custodian rep maps to another advisor. One account is affected: its balance is shown to the Salesforce-household advisor but attributed to the custodian-rep advisor.

**Coverage:**
- 64 distinct custodian accounts.
- 63 counted. 1 excluded for a blank balance.
- 4 Salesforce-only accounts not counted.
- 1 exact duplicate collapsed (the Fidelity file repeats one row).
- 1 negative balance included (−$12,500.00).
- 5 custodian-only accounts included, with valid balances.

**Unresolved exposure, not adjusted:** 2 accounts with combined flagged balances of $4,409,175.42. The potential double count is the smaller side, **$2,198,775.42**. A Schwab trust account is marked "Transferring" in Salesforce with an ACAT-to-Fidelity note. A custodian-only Fidelity trust account has the same owner name, registration and a balance within 10%. It may be a double count. I did not remove anything, because a note is not proof.

**Advisor disagreement with Salesforce:** 1 account, $191,998.40. It is attributed to the custodian advisor and shown separately.

Status counts: 59 matched, 5 custodian-only, 4 Salesforce-only. There are 26 exception rows in total.

## Judgment calls

1. **Custodian is the valuation source.** Salesforce decides links and household ownership only.
2. **Latest snapshot per custodian**, with dates parsed from the rows rather than the filenames. Both agree here. The two custodians are 7 days apart, so the combined total is labelled mixed-date.
3. **Account numbers:** only hyphens and spaces are removed, and letters and leading zeros are kept. Schwab `08855469` versus Salesforce `8855469` is *not* matched. Both sides get `possible_account_number_typo` and go to a human.
4. **Salesforce `Z76734738` is labelled Schwab, but that number exists at Fidelity.** It is flagged `custodian_mismatch_candidate` on both sides and not linked. The Fidelity balance counts as custodian-only.
5. **Registrations** go through the table in `normalize.ts` (see MAPPING.md). Salesforce "IRA" is coarser than "Roth IRA" or "SEP IRA", so it is compatible with any IRA subtype. Schwab "Contributory IRA" is treated as traditional. Confirm that with Operations.
6. **Blank balance is unknown, not zero.** It is excluded from sums and reported. Negative balances are kept in the net total and flagged.
7. **A missing or unparseable valuation date is flagged `missing_valuation_date`, not silently treated as an older row.** If it is the only observation, its balance is counted with an unknown as-of date. If dated observations exist, the undated rows are retained as lineage and not counted.
8. **Exact duplicates** count once with all lineage kept. **Conflicting same-date duplicates** are excluded with no winner picked. The data has none, but there is a unit test.
9. **Unknown rep codes** go to "Unassigned". They never borrow the Salesforce advisor.
10. **Duplicate-household signals** (shared email or a shared full client name) are review-only. The Mbeki and Oyelaran households are flagged. Nothing is merged automatically.
11. **Closed Salesforce account missing from the custodian** is `info`, because that is expected. An open one missing is `review`.
12. **Advisor visibility:** an advisor sees accounts whose Salesforce household belongs to them. Unlinked custodian accounts are visible to the advisor their custodian rep code maps to.
13. **Prompt injection:** one Salesforce note contains instruction-like text addressed to an AI. It is treated purely as data, flagged `suspicious_note_content`, and kept out of every prompt. The AI sees only structured, minimised facts.
14. **Exception resolutions are local.** Operations can mark an exception resolved or reopened with a note. This does not change the source data, the reconciliation result, or any approved link/merge override.
15. **Approvals** are stored as local `approved_overrides`. They are not yet re-applied to reconciliation output. See "Next".

## Auth and AI

- **Mock auth:** an HMAC-signed, HTTP-only cookie holding a seeded user id. Policy is checked in the server pages and actions (`auth/policy.ts`, `workflow/changes.ts`).
  - Advisors cannot approve, resolve, or view other advisors' rows, and cannot propose against other advisors' households.
  - Operations approve, reject, undo, and resolve/reopen exceptions. Every action writes a before/after audit row.
  - Production refuses to sign without `SESSION_SECRET`. Set `COOKIE_SECURE=1` behind HTTPS.
- **AI "Explain":** the default is the offline `mockProvider`, behind the `LlmProvider` interface. The page shows the exact prompt that would be sent, and the server logs it. Free-text exception reasons are omitted from the prompt because they can contain full account numbers. Output is `.strict()` Zod-validated and replaced by a safe fallback if invalid. It is advisory only and never auto-applied. No real model was wired up.

## Verification actually done

- `npm test`: **26 tests passed** (normalization, duplicate handling, missing dates, matching candidates, AUM rules, transfer-pair exposure, ambiguous-account visibility, idempotent ingest, batch/raw immutability, authorization, audit, resolution and undo, AI prompt minimisation and output validation).
- `tsc --noEmit` and `next build` are clean.
- `npm run ingest` twice: first run imports five files and 68 result rows; second run is all `skipped_identical`, reuses the run, and creates no extra batch.
- `npm run report`: the AUM, coverage, advisor, status and exception numbers above.
- Independent Python `Decimal` recomputation of the raw CSVs matched the AUM totals.
- HTTP smoke test (`scripts/smoke.py`, with `SESSION_SECRET` set): Operations saw 26 exception rows and the audit log. Dana saw 6 and no audit log, and her page total was $17,084,275.44 (custodian attribution). A forged cookie was redirected to login.
- Not done: no real browser or visual check, and I did not click through propose, approve, undo or resolve/reopen in a browser. That flow is covered by unit tests and direct server-function calls only.

## Next, with more time

- Apply approved overrides inside the reconciliation, so links and merges change results, with a re-run diff.
- Tests for the Next server actions and a browser test.
- Fuzzy typo candidates beyond leading zeros (transpositions).
- Per-row valuation dates when a file mixes dates, and history across daily files.
- Real session or SSO, CSRF review, and a real LLM provider behind the existing interface with redaction tests.
- Confirm with Operations the Schwab "Contributory IRA" mapping and the transfer-tolerance heuristic (10%).
