# Field mapping: custodian files → canonical model → Salesforce

`custodian_observations` is one shared table for both custodians. Salesforce fields are the closest equivalent, and gaps are flagged.

## Fidelity (`fidelity_accounts_2026-11-06.csv`)

| Source field | Canonical field | Salesforce field | Notes / conflicts |
|---|---|---|---|
| Acct Number | `account_number_raw`, `account_key` | `Financial Account.Account_Number__c` | Format `Z21-544479` against SF `Z21544479`. Only hyphens/spaces are stripped. |
| Registration | `registration_raw`, `registration` | `Registration_Type__c` | Mapped via table (below). Fidelity labels are finer than SF's (SF has plain `IRA`). |
| Primary Owner / Joint Owner | `owner_display`, `owner_name_key` | none on the account (household name only) | Format `LAST, FIRST`. The joint owner has first name only. Review signal only. **Gap:** SF has no account-owner field. |
| Tax ID | stays in raw only | none | Never used for matching or copied to canonical tables. |
| Market Value | `balance_cents`, `balance_raw` | none (SF does not hold balances) | `$1,234.56` and `-$12,500.00` forms. Blank gives NULL (unknown). |
| As Of | `valuation_date` | none | `MM/DD/YYYY` parsed explicitly. Taken from the row, not the filename. |
| Rep Code | `rep_code` → `advisors` via (`Fidelity`, code) | `Household.Primary_Advisor__c` (name) | **Conflict:** the SF advisor is a name per household. The custodian rep code is per account. 1 account disagrees. |
| (filename) | `raw_files.filename` | none | The custodian is implied by the file type. |

## Schwab (`schwab_balances_20261030.csv`)

| Source field | Canonical field | Salesforce field | Notes / conflicts |
|---|---|---|---|
| account_id | `account_number_raw`, `account_key` | `Account_Number__c` | Schwab is 8 digits, SF is `7155-5432`. Hyphens are stripped. **Leading zero lost in SF:** `08855469` vs `8855469` is a candidate only. |
| account_title | `owner_display`, `owner_name_key` | none | Title includes `& … JT TEN`. First person only for the name key. |
| account_type | `registration_raw`, `registration` | `Registration_Type__c` | `Contributory IRA` mapped to traditional (**assumption**). |
| total_value | `balance_cents` | none | Plain decimal. |
| value_date | `valuation_date` | none | ISO format. |
| advisor_code | `rep_code` → `advisors` via (`Schwab`, code) | `Primary_Advisor__c` | `RX99` is not in `rep_codes.csv`, so the account is Unassigned. |
| ssn_last4 | stays in raw only | none | The same last four appear on unrelated accounts, so it is unsafe as a key. |

## Salesforce

| File.field | Canonical | Notes |
|---|---|---|
| `sf_households.Id` | `households.sf_id` | Preserved. |
| `Name` | `households.name` | Also parsed for person names (review signal only). |
| `Primary_Advisor__c` | `primary_advisor_name`, `advisor_id` | A name. It is not a code, so it cannot be tied to custodian codes without `rep_codes.csv`. |
| `Primary_Email__c` | `primary_email` (lower-cased) | Shared emails flag duplicate-household candidates. Never a merge key. |
| `CreatedDate` | `created_date` | ISO. Unused by the reconciliation. |
| `sf_financial_accounts.Id` | `sf_financial_accounts.sf_id` | Preserved. |
| `Household__c` | `household_sf_id` | Intentionally not an FK, so a dangling link is reported as `orphan_household_link`. None are dangling in the supplied data. |
| `Account_Number__c` | `account_number_raw`, `account_key` | See above. |
| `Custodian__c` | `custodian` | A custodian that is not Fidelity or Schwab gives `invalid_identity`. One SF row has a Fidelity-style number under Schwab. |
| `Registration_Type__c` | `registration` | `Joint`, `Trust`, `Individual`, `IRA`, `Roth IRA`, `SEP IRA`. |
| `Status__c` | `status` | `Open`, `Transferring`, `Closed`. Closed with a custodian balance gives `status_conflict`. |
| `Notes__c` | `notes` | Untrusted free text. Used only for regex flags (transfer words, instruction-like text). Never sent to a model. |
| `rep_codes.*` | `rep_code_map` (custodian, rep_code) → advisor | Rep codes are scoped by custodian; the key is the pair, not the code alone. |

## Registration mapping table (`REGISTRATION_MAP` in `src/lib/ingest/normalize.ts`)

| Canonical | Labels |
|---|---|
| individual | Individual, INDV |
| joint | JTWROS, JT TEN WROS, Joint Tenants WROS, Joint |
| trust | TRUST-REVOCABLE, REV TRUST, Living Trust, Trust |
| ira_traditional | IRA-TRADITIONAL, TRAD IRA, Contributory IRA, IRA - Traditional |
| ira_roth | ROTH IRA, ROTH, Roth Contributory IRA |
| ira_sep | SEP IRA, SEP |
| ira_unspecified | IRA (Salesforce only) |
| unknown | anything else, which raises `unknown_registration` |

## Gaps

- Salesforce has no balance, valuation date or owner on the account. Value always comes from the custodian.
- There is no shared stable customer key across systems, so households cannot be linked by identity and are never merged automatically.
- Fidelity's `Joint Owner` has first name only.
- Transfer intent exists only in free-text notes and a status value.
