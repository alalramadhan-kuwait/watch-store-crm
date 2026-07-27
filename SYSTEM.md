# Timekeeper — System Reference

> **Purpose of this file:** the single source of truth for how the Timekeeper systems fit together — architecture, data model, modules, integrations, conventions. It is the reference Claude reads before making changes, and **it must be updated in the same change whenever the system changes** (new module, table, edge function, cron job, role, convention, or a notable fix). Keep the Changelog at the bottom current.
>
> **This is a mirror.** The same file lives in both repos (`timekeeper-online/SYSTEM.md` and `watch-store-crm/SYSTEM.md`) because the two apps share one system — keep the two copies identical when you update either.
>
> Last updated: **2026-07-25**

---

## 1. Overview

Timekeeper is a Kuwait watch retailer. Two connected web apps run the business, **sharing one Supabase project**:

| App | Repo | Role | Hosting |
|-----|------|------|---------|
| **Timekeeper Online** | `timekeeper-online` | Operations control: purchasing, stock, HR, marketing, dashboards | GitHub Pages |
| **Daily Sales Report (DSR)** | `watch-store-crm` (`../watch-store-crm`) | Point-of-day sales logging, follow-ups, per-outlet daily reports (PDF) | GitHub Pages |

**Boundary rule (memorise this):**
- Sales entry, follow-ups, closing the day → **DSR**.
- Everything operational — purchasing, stock, HR, marketing, targets, dashboards → **Timekeeper Online**.
- Anything that scans at the register or changes stock count → **Lightspeed** (POS, source of truth for stock and POs).
- A promise, a payment owed, a person, or an expiry date → **Timekeeper Online**.

**Outlets:** Timekeeper HQ, **Avenues**, **Time Gallery** (stored in `cases.outlet` as `Avenues` / `TimeGallery`).

---

## 2. Tech stack

- **Frontend:** React 18 + TypeScript + Vite + TailwindCSS, **HashRouter** (required for GitHub Pages).
- **Backend:** Supabase — PostgreSQL + RLS, Edge Functions (Deno), pg_cron + pg_net, Storage buckets, Auth.
- **Supabase project ref:** `ttshgrujnycapugrmyxs` (shared by both apps).
- **Integrations:** Lightspeed X-Series (POS), Instagram Graph API, Resend (email, parked).
- **Locale:** `Asia/Kuwait` (UTC+3); week starts Saturday; currency KD, 3 decimals.
- **Deploy:** `npm run deploy` pushes `dist` to `gh-pages`. **This does NOT commit source** — always `git commit` + `git push origin main` as well. Commit messages end with the Co-Authored-By trailer.

---

## 3. Frontend architecture

- **`src/App.tsx`** — routes (HashRouter). Every guarded route wraps in `g(path, element)` = `canAccessPath` check.
- **`src/components/Layout.tsx`** — nav groups + `PAGES` catalogue + `canAccessPath(to, role, pageAccess)`; activity logging on route change. `<main>` is full width (`w-full`, no max-width).
- **`src/context/AuthContext.tsx`** — `useAuth()` → `{ user, profile, role, pageAccess, loading, signIn, signOut }`.
- **`src/components/CrudModule.tsx`** — the generic CRUD engine most pages are built on. See §7.
- **`src/components/ui.tsx`** — `Card`, `Badge`, `StatusBadge`, `Modal`, `Spinner`, `statusColors`.
- **`src/lib/`** — `supabase.ts`, `format.ts` (`formatKD`, `formatKDCompact`), `expiry.ts` (`expiryTier`/`tierClass`/`tierLabel`), `lateness.ts`, `locationType.ts`, `activity.ts`, `alerts.ts` (`buildAlerts`).

### Nav groups (Layout.tsx) & routes

| Group | Pages (route → label) |
|-------|-----------------------|
| Dashboard / My Portal | `/` Dashboard · `/me` My Portal |
| Sales & Customers | `/sales` · `/crm` · `/follow-ups` · `/waiting-list` · `/pre-orders` · `/vip` |
| Purchasing & Stock | `/purchase-orders` Supplier Payments · `/stock` Stock (Lightspeed) · `/consignments` · `/limited-projects` · `/repairs` |
| HR & Team | `/attendance` · `/hr` Employees · `/leave` |
| Media & Marketing | `/instagram` · `/content` Content Planner · `/paid-ads` · `/influencers` |
| Admin | `/activity` User Activity · `/history` History Log · `/settings` |

`/company-documents` exists (module + data) but is hidden from the menu; direct URL works.

---

## 4. Roles & access

Roles seen in `profiles.role`: **admin, manager, staff, operations** (also referenced in code: sales, marketing, hr, viewer).

Role-helper predicates (`src/pages/modules.tsx`):
```ts
salesRoles       = ['admin','manager','staff','sales']
purchasingRoles  = ['admin','manager','operations']
hrRoles          = ['admin','hr']
marketingRoles   = ['admin','manager','marketing']
```

Two access layers, both enforced:
1. **UI** — nav `roles` + `canAccessPath` (with per-user `profiles.page_access` override) gate page visibility; `CrudConfig.canWrite(role)` gates the edit/add controls.
2. **Database RLS** — the real guard. Typical pattern: read = `auth.role() = 'authenticated'`; write = `get_my_role() = any(array[...])`.

`profiles` columns: `id, full_name, role, page_access (jsonb|null), created_at, updated_at`. There is **no username column** — login identity is the auth email. `page_access = null` means default role-based access.

---

## 5. Database — tables

Public base tables (Supabase project `ttshgrujnycapugrmyxs`):

**Sales / CRM (shared with DSR):** `cases` (has `outlet`, `case_type`, `amount_kd`, `date_logged`, `deleted`, `sale_items(amount_kd)`), `sale_items`, `customers`, `day_closes`, `brands`, `settings`.

**Purchasing & stock:** `purchase_orders`, `purchase_order_items`, `consignments`, `limited_projects`, `waiting_list`, `pre_orders`, `repair_watches`, `lightspeed_auth`, `lightspeed_stock`, `lightspeed_stock_cost`, `lightspeed_product_sales`, `lightspeed_stock_value_history`, `lightspeed_sync_log`.

**HR:** `employees`, `attendance_records`, `leave_records`, `employee_requests`, `geofences`, `company_documents`.

**Marketing:** `content_tasks`, `paid_ads`, `influencer_campaigns`, `instagram_auth`, `instagram_daily`, `instagram_media`, `instagram_sync_log`.

**Platform:** `profiles`, `user_activity`, `audit_log`, `alert_actions`.

### `settings` (single row) — dashboard config
`sales_target_month`, `sales_target_avenues`, `sales_target_timegallery` (per-outlet monthly targets), plus brand list, work-start time, etc.

### `purchase_orders` — see §6.1 for the full lifecycle. Key columns:
`ls_consignment_id` (unique; null = manual/legacy), `source` ('lightspeed' | 'manual'), `po_number` (= Lightspeed **reference**, e.g. `MAI-1234`), `supplier_invoice_no`, `supplier`, `brand`, `outlet`, `created_date`, `expected_arrival`, `status`, `item_count`, `ordered_qty`, `received_qty`, `total_cost` (all NOT NULL with defaults), `amount_paid`, `payment_status` (Unpaid|Partial|Paid), `payment_date`, `payment_method`, `invoice_received`, `team_notified`, `notes`, `linked_project`, `merged_into` (self-FK → the synced PO a legacy row folded into), `match_candidate_id` (uuid FK → suggested match), `ls_synced_at`.

### DB functions (security definer, service_role/authenticated)
- `get_my_role()` — role of the calling user, used by RLS.
- `po_match_legacy()` — auto-merges legacy POs onto their Lightspeed twin on exact `po_number` match (carries payment history, sets `merged_into`); records weaker matches as `match_candidate_id`. Returns `(auto_linked, suggested)`.
- `po_fill_brands()` — fills a synced PO's `brand` from the dominant-value product on it (leaves hand-set brands alone).
- `po_summary()` — JSON for the PO dashboard cards: `owed_kd, owed_count, receipt_count, receipt_kd, invoice_count` (excludes merged/cancelled; live obligations only).

---

## 6. Lightspeed integration

OAuth (Standard Access, own account); long-lived token + refresh in `lightspeed_auth` (single row `id=1`, holds `access_token`, `refresh_token`, `domain_prefix='timekeeper'`, `expires_at`, `sync_key`). Base URL `https://timekeeper.retail.lightspeed.app`. Rate limit ~200 calls/hour. All edge functions include CORS + an OPTIONS handler (a recurring gotcha — always include it).

### 6.1 Purchase Orders — Lightspeed is the source of truth
Lightspeed models POs as **SUPPLIER consignments** (`OPEN → SENT → DISPATCHED → RECEIVED`, `CANCELLED`). POs are **created in Lightspeed, never hand-entered** in Timekeeper. `lightspeed-po-sync` mirrors them; Timekeeper owns only the money/coordination side.

- **Order number** = consignment `reference` (e.g. `MAI-1234`), NOT `name` (blank on ~90% of consignments). `supplier_invoice` → `supplier_invoice_no`.
- **Status map:** OPEN→Pending Approval; SENT/DISPATCHED→Ordered; RECEIVED/CLOSED→Fully Received; CANCELLED→Cancelled. **Partially Received is derived** when `0 < received_qty < ordered_qty` (Lightspeed has no such status).
- **Ownership:** the sync writes only Lightspeed-owned columns; it never touches `amount_paid, payment_status, payment_date, payment_method, invoice_received, team_notified, notes, linked_project`.
- **Totals/brand** come from line items (`/consignments/{id}/products`) → `purchase_order_items` + `po_fill_brands()`. Line items are the expensive call, so they are queued (in-flight POs first, then newest-first backfill), capped ~120/run.
- **Legacy rows** (hand-entered before the sync, `source='manual'`): auto-merge only on exact order-number match; weaker matches surface in the **Review legacy matches** panel on the PO page for a human to confirm. `merged_into` makes any merge reversible; merged rows are hidden from the list.
- **Cancellations** (important gotcha): the `/consignments?type=SUPPLIER` **list endpoint omits CANCELLED consignments entirely** — a cancelled PO simply vanishes from the feed. The sync therefore ends with a **reconciliation pass**: any still-open synced PO whose id is missing from this run's feed is single-fetched (`/consignments/{id}` DOES return cancelled/deleted) and set to `Cancelled` (or its true status). Without this, a cancel would never be captured and the PO would stay frozen at its last-seen status. The daily sync also means a cancel made after 08:05 Kuwait only reflects next run (or on "Sync POs now").
- **Historical settlement:** POs received before payment tracking began (and received-but-untracked ones) were marked Paid, tagged in `notes` with `[auto: … marked settled]` — reversible.

### 6.2 Stock (`lightspeed-sync`)
Daily import of products, inventory, sales, outlets, cost → `lightspeed_stock`, `lightspeed_stock_cost` (RLS: admin/manager only), `lightspeed_product_sales`, `lightspeed_stock_value_history`. Cost/margin are manager-visible only, everywhere.

---

## 7. CrudModule (`src/components/CrudModule.tsx`)

Generic table+form engine. Config type `CrudConfig`:
- Fields: `FieldDef { key, label, type, options, required, defaultValue, placeholder, bucket, parse, display, readOnly, hint }`. Types: `text | number | date | select | combobox | textarea | checkbox | image`.
- Columns: `ColumnDef { key, label, sortable, sortValue, render, hideBelow ('sm'|'md'|'lg'|'xl') }`.
- Config: `statusField, statusOptions, searchKeys, orderBy, canWrite, stampCreatedBy, beforeSave, onChanged, filter, toolbarExtra, rowClickToEdit, extraFilters, groupBy, allowCreate, allowDelete(row), formExtra(row)`.

Behaviour worth knowing:
- **`readOnly` fields** render disabled AND are stripped from the save payload (both in `RecordForm` submit and `save()`), so a synced/other-owned column is never written back (this fixed the `item_count` NOT-NULL error). Use for externally-owned columns.
- **`load()` paginates** past PostgREST's 1000-row cap, so client-side filters see every row (matters for `purchase_orders`, ~2,000 rows).
- **`groupBy`** renders group-header rows when no explicit column sort is active.
- All tables should be sortable, mobile-friendly, and never cut off (`overflow-x-auto`, `whitespace-nowrap` on KD cells).

---

## 8. Key pages (beyond plain CrudModule)

- **`src/pages/Dashboard.tsx`** — sectioned KPI overview (`KpiCard`/`Section`) + alerts (`AlertActionPanel`). Sales from `cases`; **`caseTotal()` uses `sale_items.amount_kd` when present** (it is already the line total — do NOT multiply by quantity; a past bug double-counted). Per-outlet target cards ("Avenues vs target", "Time Gallery vs target") appear only when their target is set. **Owner-view charts** (via `src/components/Charts.tsx`, dependency-free SVG): each `Section` takes an optional `charts` node rendered under the cards. Live: Sales trend (cumulative, line), Sales by outlet vs target (bar w/ target marker), Stock value over time (line), Supplier balance by brand (bar), Repairs by status (bar), Instagram followers trend (line). Dashboard rule: **KPIs, trends, comparison, risk, action only — no large tables** (details live on each page). Backlog charts: Lost-sales trend, Demand by brand, Not-moving stock over time, Late-trend by week, Paid-ads by status, IG reach/engagement.
- **`src/pages/PurchaseOrders.tsx`** — the PO page. Three clickable summary cards (Outstanding balance / Awaiting receipt / Awaiting invoice from `po_summary()`), a "Sync POs now" button, read-only synced fields + editable payment block, line-items viewer (`formExtra`), legacy-match review panel, brand grouping + collapsible Completed section. Project-linked POs show a violet flag on the Order # cell. `allowCreate:false` (no manual POs).
- **`src/pages/Stock.tsx`** — 8 clickable KPI cards, product & brand views, stock-value history chart. Product view shows **Avg cost / Retail / Margin** (cost & margin manager-only). Brand view shows Cost value + Margin.
- **`src/pages/Settings.tsx`** — user/role admin (via `admin-users` fn), page-access editor, **Monthly sales targets** (overall + Avenues + Time Gallery), brands, geofences, work-start time, Daily Briefing email.
- **`src/pages/MyPortal.tsx`, `Attendance.tsx`, `Leave.tsx`** — employee portal, clock-in/out, lateness bands (9–5, grace to 10:00, Minor/Late/Serious late, early-leave before 17:00), leave/sick/WFH requests.
- **`src/pages/Instagram.tsx`** — Instagram performance (auto-sync). Insights only available for own account via Graph API.
- **`src/pages/modules.tsx`** — home of most CrudConfigs: contentTasks, paidAds, **influencers**, repairWatches, demandList, consignments, vipCustomers, employees, companyDocs, limitedProjects. Exports the page components.
- **`src/pages/UserActivity.tsx`, `HistoryLog.tsx`** — admin audit views.

---

## 9. Edge functions (Deno, Supabase)

| Function | verify_jwt | Trigger | Purpose |
|----------|-----------|---------|---------|
| `lightspeed-oauth-callback` | false | OAuth redirect | Completes Lightspeed OAuth, stores token |
| `lightspeed-sync` | false | cron + manual | Daily stock/sales/cost import |
| `lightspeed-po-sync` | false | cron + admin/manager JWT | Mirror SUPPLIER consignments → POs (§6.1) |
| `admin-users` | true | Settings UI | Create/edit/delete users, change password/role |
| `daily-briefing` | false | cron (parked) | Email daily briefing (needs `RESEND_API_KEY`) |
| `instagram-connect` | true | Settings UI | Instagram OAuth connect |
| `instagram-sync` | false | cron + manual | Instagram followers/media/insights import |

Auth for cron-callable syncs: `x-sync-key` header = `lightspeed_auth.sync_key`, OR an admin/manager JWT. Edge functions get **~150s wall clock** and PostgREST caps selects at 1000 rows — heavy syncs must batch/paginate and respect the deadline.

## 10. Cron jobs (pg_cron, UTC)

| Job | Schedule (UTC) | Kuwait | Calls |
|-----|----------------|--------|-------|
| `lightspeed-daily-sync` | `0 5 * * *` | 08:00 | `lightspeed-sync` |
| `lightspeed-po-sync` | `5 5 * * *` | 08:05 | `lightspeed-po-sync` |
| `instagram-daily-sync` | `15 5 * * *` | 08:15 | `instagram-sync` |

Cron calls use `net.http_post` with the `x-sync-key` header and `timeout_milliseconds := 150000`.

---

## 11. DSR (watch-store-crm) notes

- `src/utils/report.ts` — `buildDailyStats`; **follow-up conversions are separated** from the normal daily report (`followUpWins`, `followUpWinRevenue`, `dayCases`). Brand Analytics PDF has **no Lost column**. `shareReport` → `'shared'|'downloaded'|'cancelled'`.
- `src/components/TodayLog.tsx` — close day, PDF share; staff can pull only **yesterday's** report, admin any past day.
- `src/components/Reports.tsx` — admin "report for any day + outlet" builder (`day_closes` are per-outlet).
- `src/db/index.ts` — `closeDay` does NOT lock open follow-ups (`day_locked = !isOpenFollowUp`), so staff can keep updating them (RLS: `day_locked=false AND created_by=auth.uid()`).

---

## 12. Conventions & gotchas

- **Every edge function** needs the CORS const + `if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })`. Missing it = "non-2xx"/"Failed to send a request".
- `supabase.functions.invoke` returns a wrapper error message — parse `error.context.clone().json()` for the real reason.
- Lightspeed OAuth needs `&state=tkonline-${Date.now()}` (else `invalid_state`).
- Tables: `overflow-x-auto` (not `overflow-hidden`), `whitespace-nowrap` on KD cells; add `sortValue` for computed columns.
- Icons: import from `lucide-react`; `IdCard` isn't exported (use `LogIn`). Adding a **new** lucide import needs a Vite dep re-optimize — a stale dev-server HMR error can be a ghost; `vite build` is the truth.
- This file has **no `React` import in some pages** — use `JSX.Element`, not `React.ReactNode`, for local prop types (e.g. Stock/PurchaseOrders).
- Resend free tier only delivers to the registered address.

---

## 13. Changelog

- **2026-07-27** — Fixed **cancelled POs never syncing**: Lightspeed's consignment list omits CANCELLED, so cancels were invisible. Added a reconciliation pass to `lightspeed-po-sync` that single-fetches vanished open POs (MAI-417 + 4 others were stuck). Also normalised the function source to ASCII.
- **2026-07-25** (later) — **Owner-view dashboard charts** added (`src/components/Charts.tsx`): 6 first charts across Sales, Stock & Purchasing, Repairs, Marketing sections. `Section` extended with a `charts` slot.
- **2026-07-25** — Created this reference. Added **Influencer Tracker** (`influencer_campaigns`, `/influencers`). Added **per-outlet sales targets** (Avenues, Time Gallery) in Settings + dashboard cards. Stock product view gained **Avg cost / Retail / Margin**. Fixed CrudModule NOT-NULL save error (read-only fields now stripped from payload) + paginated `load()`. PO page: **order number now from Lightspeed `reference`** + `supplier_invoice_no`; **3 summary cards** (Outstanding balance / Awaiting receipt / Awaiting invoice); **project-linked flag**; table slimmed to 8 columns. Historical/untracked received POs marked settled. `lightspeed-po-sync` deployed + daily cron.
- **≤2026-07-24** — PO source-of-truth migration (Lightspeed = master, lifecycle Pending Approval/Ordered/Partially Received/Fully Received/Cancelled, `purchase_order_items`, legacy matching). DSR follow-up log separation, per-day/outlet reports, staff yesterday-only. Media & Marketing section (Instagram sync, Content Planner, Paid Ads). HR: attendance, lateness rules, leave/sick/WFH, employee portal, geofences. Stock (Lightspeed) page + dashboard rebuild. Username-based access control, activity log, history log.
