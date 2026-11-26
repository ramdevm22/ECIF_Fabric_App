# ECIF Supplier Scope & Milestones - Microsoft Fabric App

A form-based web app, built on the **Rayfin Universal App Template** as a **Microsoft Fabric App (Rayfin)**, that replaces the ECIF supplier scope and milestone Excel template. Requestors fill in and submit ECIF requests; reviewers approve, reject or ask for changes; the data is ready for **Power BI** reporting.

> Status: working prototype. See [Known limitations](#known-limitations) before using it for real data.

---

## Table of contents
1. [About ECIF](#about-ecif)
2. [What this app does](#what-this-app-does)
3. [Roles and access](#roles-and-access)
4. [Fabric items and services used](#fabric-items-and-services-used)
5. [Tech stack](#tech-stack)
6. [Project structure](#project-structure)
7. [Data model](#data-model)
8. [Getting started](#getting-started)
9. [Configuration: reviewers](#configuration-reviewers)
10. [Deploying to Fabric](#deploying-to-fabric)
11. [Power BI](#power-bi)
12. [Testing](#testing)
13. [Troubleshooting](#troubleshooting)
14. [Known limitations](#known-limitations)
15. [Roadmap](#roadmap)
16. [Security and GitHub notes](#security-and-github-notes)

---

## About ECIF

**ECIF** stands for **End Customer Investment Fund**. It is Microsoft funding for project work that a supplier delivers to an end customer. To obtain it, a request describes:

- the **customer** and the **supplier** (names, contacts, supplier ID, service location),
- the **project scope**: what is delivered, why and how, the start date, the currency and any travel expenses,
- the **milestones**: name, description, work type, due date and amount,
- the **roles** behind each milestone: supplier role, number of resources, hours per resource and weeks.

Microsoft reviews the request before the work is funded. Approval can take up to two weeks, so the project start date should allow for that. The request is usually collected in an Excel template (`Supplier_scope_and_Milestone_template_Rate_Based`) that is filled in by hand and sent around. This app replaces that template.

*This README describes the app's design. It is not an official statement of ECIF policy; always follow Microsoft's current ECIF guidance.*

---

## What this app does

**For requestors** (suppliers and Microsoft contacts)
- **Landing page** that explains ECIF and offers two entry points: *Sign in as requestor* and *Sign in as reviewer*.
- A **four-tab form** that mirrors the Excel template:
  1. *Account & Contact Info*
  2. *Project Scope* (summary and up to 200 milestones; the project end date is calculated from the latest due date)
  3. *Milestone Details* (roles, resources, hours, weeks per milestone)
  4. *Summary* (read-only table with hours, months, amounts, sub-totals, travel and project total)
- Field **validation** that follows the template rules (required fields, email format, whole numbers, unique milestone names, due date on or after the start date, character limits). Mandatory fields show a red star.
- **Save as draft**, **Submit** (locks the request), **Reopen** and **Delete**.
- A warning before leaving with unsaved changes.
- **Download CSV (opens in Excel)** and **Print / Save as PDF** of the summary.
- The reviewer's **decision and comment** shown on the request; approved requests are locked.

**For reviewers**
- **Review screen** listing all *submitted* requests, with a status filter (pending, approved, changes requested, rejected), totals and **Export list (CSV)**.
- Open a request, read its details, then **approve** (with the approved amount), **request changes** or **reject**. Rejecting or requesting changes requires a comment.
- Decision history per request.

**For reporting**
- Two SQL views (`vw_EcifRequestFlat`, `vw_EcifMilestoneFlat`) that Power BI can read directly.

---

## Roles and access

| | Requestor | Reviewer |
|---|---|---|
| See own drafts and submitted requests | Yes | Yes |
| See other people's **submitted** requests | No | Yes |
| See other people's drafts | No | No |
| Create / edit / submit / reopen / delete own requests | Yes | Yes |
| Edit or delete **other people's** requests | No | No |
| Write review decisions | No | Yes |

- Access rules are declared in the data model (`@role` policies) and enforced by the Fabric backend, not only by the screens.
- Everyone signs in with the same **Microsoft (Fabric) sign-in**. A **reviewer** is a person whose sign-in email is in the reviewer list ([configuration](#configuration-reviewers)). The two buttons on the landing page only choose which screen to open; they do not grant access.
- A request that has a review decision can only be deleted by a reviewer who owns it, because only reviewers can delete decisions.

---

## Fabric items and services used

| Item / service | What it is used for |
|---|---|
| **Fabric workspace** (on a Fabric capacity or trial) | Holds the items below. Workspace access is the sign-in boundary for the app. |
| **Fabric App item (Rayfin)** | The app itself: backend definition, data access layer and hosting of the web front end. |
| **Fabric SQL database** (child item of the app) | Stores requests, milestones, role lines and review decisions. Tables are created from the entity classes in `packages/data`. |
| **Rayfin data API** (GraphQL) | The front end reads and writes data through `getRayfinClient()`; the access rules run here. |
| **Static web hosting for Fabric Apps** | Serves the built front end (a `*.fabricapps.net` address). |
| **Microsoft sign-in through Fabric** | Authentication through `@microsoft/rayfin-auth` and `@microsoft/rayfin-auth-provider-fabric`. |
| **Power BI** (optional) | Reporting over the two SQL views. |

Not used: Fabric storage, functions, notebooks, pipelines or lakehouses.

> The SQL database is a child item of the app. Do **not** change its tables in the Fabric portal; change entities in code and run `db apply`, otherwise the app can break.

---

## Tech stack

- **Front end:** React 19, TypeScript, Vite, Tailwind CSS 4 (template), plus a custom Fluent-style stylesheet (`ecif.css`) for the ECIF screens
- **Backend:** Rayfin / Fabric Apps (`@microsoft/rayfin-core` decorators for entities and access policies)
- **Database:** Fabric SQL database (MSSQL dialect)
- **Tests:** Vitest
- **Tooling:** Rayfin CLI (`npx rayfin ...`)

---

## Project structure

```
.
├── rayfin/
│   └── rayfin.yml                    # Rayfin app configuration
├── packages/
│   ├── data/src/                     # Database model and access rules
│   │   ├── EcifRequest.ts            #   request (account, scope, status, owner)
│   │   ├── Milestone.ts              #   milestone rows
│   │   ├── MilestoneRole.ts          #   role lines of a milestone
│   │   ├── ReviewDecision.ts         #   reviewer decisions
│   │   ├── access.ts                 #   reviewer check used in the policies
│   │   └── index.ts                  #   registers the entities
│   ├── shared/src/                   # Code shared by data and front end
│   │   ├── index.ts                  #   record types and UniversalAppSchema
│   │   ├── lookups.ts                #   dropdown lists (work types, roles, currencies, locations)
│   │   └── reviewers.ts              #   reviewer email list
│   └── frontend/src/
│       ├── Root.tsx                  #   landing page / sign-in gate
│       ├── App.tsx                   #   renders the ECIF app for the chosen role
│       └── ecif/
│           ├── Landing.tsx           #   landing page
│           ├── Root.tsx              #   role-based screen choice
│           ├── EcifApp.tsx           #   requestor form (4 tabs)
│           ├── ReviewerApp.tsx       #   reviewer screen
│           ├── components/           #   Account, Scope, Details, Summary tabs and field wrapper
│           ├── api.ts                #   save / load / delete requests
│           ├── review.ts             #   list and write review decisions
│           ├── calc.ts               #   hours, months, totals, CSV
│           ├── validation.ts         #   validation rules from the Excel template
│           ├── submit.ts             #   checks before submit
│           ├── types.ts, scrollTop.ts, ecif.css
│           └── ecif.test.ts          #   unit tests
├── powerbi_views.sql                 # SQL views for Power BI
└── HANDOVER.md                       # Short hand-over notes
```

---

## Data model

```
EcifRequest 1 ──< Milestone 1 ──< MilestoneRole
     1
     └──< ReviewDecision
```

| Table (entity) | Purpose |
|---|---|
| `EcifRequest` | One ECIF request: customer, supplier, contacts, scope text, start date, currency, travel, status (`draft` / `submitted`), owner id and email |
| `Milestone` | Milestone name, description, work type, due date, amount, sort order |
| `MilestoneRole` | Role, number of resources, hours per resource, weeks |
| `ReviewDecision` | Decision (`approved` / `rejected` / `changes_requested`), approved amount, comment, reviewer, date |

Every table has an `owner_id` column; access policies compare it with the signed-in user.

Rayfin rules that matter when you change the model:
- every `@text` needs a `max`, and on MSSQL `max` must be 4000 or less;
- foreign key columns must be `@uuid()`;
- entity names must match the keys of `UniversalAppSchema` in `packages/shared/src/index.ts`;
- model changes are applied with `db apply`; destructive changes need `--force`.

---

## Getting started

### Prerequisites
- A **Microsoft Fabric workspace** on an **active capacity** (a trial capacity works) where you may create items
- **Node.js 20, 22 or 24** and npm (the versions the Rayfin template supports)
- Docker Desktop or Docker Engine only if you use the Docker development provider (not needed for the normal workflow)
- Access to the Rayfin CLI packages (installed through npm from the project's dependencies)
- A code editor such as VS Code

### Run it locally
```bash
git clone <this-repository-url>
cd <project-folder>

# install dependencies once, from the workspace root
npm install

# sign in to Fabric (also to switch accounts)
npx rayfin login

# start the Rayfin local services and the front end
npm run dev
```

To work on the screens only:
```bash
npm run dev:frontend
```
Sign-in and data need a Fabric backend. Without one, the sign-in gate shows a configuration message.

### Useful commands

| Command | What it does |
|---|---|
| `npx rayfin login` | Sign in to Fabric from the CLI |
| `npm run dev` | Start the Rayfin local services and the front end (run from the root) |
| `npm run dev:frontend` | Start only the front end dev server |
| `npm run build` | Build shared, data and front end in order |
| `npm run typecheck` | Type-check the workspace projects |
| `npm test` | Run the front end tests |
| `npm run rayfin:up` | Provision or update the app's Fabric resources (deploy) |
| `npx rayfin up db apply` | Create or update the database tables from the entities |
| `npx rayfin up db apply --force` | Same, but allows destructive changes (drops) |
| `npx rayfin up` | Deploy backend and front end to Fabric |
| `npx rayfin up --dry-run` | Show what a deploy would do |
| `npx rayfin up status` | Show deployment status |
| `npx rayfin up staticapp deploy` | Deploy only the front end |

---

## Configuration: reviewers

Reviewers are defined in **`packages/shared/src/reviewers.ts`**:

```ts
export const REVIEWER_EMAILS: readonly string[] = [
  'reviewer@example.com', // replace with real sign-in emails, in lower case
];
```

After changing the list:
```bash
npx rayfin up db apply   # updates the database access rules
npx rayfin up            # redeploys the front end
```

Notes:
- The email must match the Microsoft sign-in email (lower case).
- The list is read both by the database rules (the real protection) and by the screens (a convenience).
- No documented way was found to assign per-user roles in Rayfin, so the app uses this list.

---

## Deploying to Fabric

1. Create or choose a Fabric workspace with an active capacity.
2. `npx rayfin login`
3. `npx rayfin up db apply` (creates the tables)
4. `npx rayfin up` (deploys the app)
5. Open the app from the Fabric workspace and share it with users through the **Share** button, or add them to the workspace. Test with a second, non-reviewer account.

---

## Power BI

`powerbi_views.sql` creates two read-only views:

- `vw_EcifRequestFlat` - one row per submitted request with milestone total, travel, requested total, review status and approved amount
- `vw_EcifMilestoneFlat` - one row per milestone with amount and total hours

Run each `CREATE OR ALTER VIEW` statement **separately** in the Fabric SQL query editor (the editor does not accept `GO`). Check that the table names in the script match your database (the app's tables are plural, for example `EcifRequests`). Then connect Power BI Desktop to the database (SQL Server connector) and load the two views, related on `RequestId`.

Direct database and Power BI access are controlled by Fabric workspace permissions, not by the app's rules. Treat them as full access to all data.

---

## Testing

```bash
npm test
```
The unit tests (`ecif.test.ts`) cover the hours and totals, the summary and CSV output, and the validation and submit rules.

Manual test data: use a sample request with 3 milestones and 5 role lines, such as the dummy dataset in the project documents. Expected result for that set: 340 total hours, milestone sub-total 11,500, travel 500, project total 12,000.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `CapacityLimitExceeded` / `CapacityNotActive` | The Fabric capacity is full or paused. Ask the Fabric admin to resume or free it. |
| `unable to get local issuer certificate` (TLS) | Set `NODE_OPTIONS=--use-system-ca` (PowerShell: `$env:NODE_OPTIONS="--use-system-ca"`). Do **not** disable TLS verification. |
| `db apply` blocked by a table drop | Review the change, then run `npx rayfin up db apply --force` if the drop is intended. |
| Schema error: text max exceeds 4000 | Use `max` of 4000 or less on `@text`. |
| Foreign key type error | Foreign key columns must be `@uuid()`. |
| "Cannot find module" in VS Code | Run *TypeScript: Restart TS Server*. |
| Review button not visible | Your sign-in email is not in `reviewers.ts`, or you did not run `db apply` and redeploy after editing it. |
| Delete fails with "other items depend on this record" | The request has review decisions; only a reviewer who owns it can delete it. |
| Page opens halfway down after choosing a role | Make sure `scrollTop.ts` is in place and `Root.tsx` / `Landing.tsx` use it. |

---

## Known limitations

- **Months calculation:** the Excel formula is hidden, so months are estimated as weeks / (52/12). Confirm the real rule in `calc.ts`.
- **No currency conversion:** the USD / local currency conversion of the Excel sheet is not included.
- **Mixed currencies:** the reviewer's "total approved" adds amounts of different currencies together.
- **Approved lock is in the screen only:** the database still lets an owner edit their own rows if they bypass the app.
- **Reviewers are a fixed email list;** changing it needs `db apply` and a redeploy.
- **No notifications** (email or Teams) yet.
- **No history of deleted requests** yet (see roadmap).
- Direct database access bypasses the app's rules.

---

## Roadmap

- Activity history (added, submitted, reopened, removed, decided) kept in its own table
- "Cancelled" status instead of deleting reviewed requests
- Database-level lock for approved requests
- Email or Teams notifications (for example with Power Automate)
- Supplier lookup by ID
- Attachments (statements of work, quotes)
- Real `.xlsx` export that matches the original template
- Power BI report on the two views

---

## Security and GitHub notes

- **Do not commit secrets or environment files** (`.env`, tokens, generated config). Check your `.gitignore` includes `node_modules`, `dist`, `.env*` and any generated Rayfin config.
- **Do not commit real data**: customer names, supplier details, exported CSV files, screenshots of real requests.
- `reviewers.ts` contains email addresses. In a **public** repository, use placeholder emails and keep the real list private (or use a private repository).
- Fabric workspace and item IDs in logs, screenshots or config files should not be published.
- Keep TLS verification on (see [Troubleshooting](#troubleshooting)).

---

## Template

The project started from the Rayfin *Universal App Template* (React, Vite, authentication gate, theming, error boundary, npm workspace with `frontend`, `data` and `shared` packages). The template's own README explained its workspace layout, capability packs (`npm run pack:add -- analytics | functions | storage`) and root commands. Those root commands are listed above; capability packs are not used in this app.

## License

Add a license file if you want others to reuse the code. If the project is internal to your organisation, say so here and keep the repository private.
