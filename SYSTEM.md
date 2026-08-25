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
| Media & Marketing | `/instagram` · `/content` Content Planner · `/paid-ads` · `/influencers` (+ `/influencers/:id` profile) |
| Admin | `/activity` User Activity · `/performance` Employee Performance · `/history` History Log · `/settings` |

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

**Marketing:** `content_tasks`, `paid_ads`, **`influencers`** (permanent profile: name, handle, platform, tier, country, followers, followers_updated, contact, photo_url, status [Active/Prospect/Paused/Inactive], rating, notes) + **`influencer_collaborations`** (one row per collab, FK influencer_id: campaign, product_brand, product, collab_type [Paid/Gift/Affiliate/Event], platform, coverage, deliverables, agreed/posted dates, fee, amount_paid, gift_value, attributed_revenue, payment_status, status, engagement, owner, notes) + **`influencer_follower_snapshots`** (influencer_id, snapshot_date, followers — for the growth graph & 30/90d deltas). `influencer_campaigns` = **legacy** flat table, migrated into the above (1 row → 1 influencer + 1 collab), kept for rollback. `instagram_auth`, `instagram_daily` (**multi-account**: PK `(snapshot_date, username)`, cols incl. `followers`, `follows_count`, `last_post_date`, `media_count`; `reach`/`impressions`/`profile_views` only fillable by the Meta path, null from the scraper), `instagram_posts` (per-post engagement: PK `shortcode`, cols `username, posted_at, type, likes, comments, video_views, caption, hashtags[], url`; last ~12 posts/account refreshed daily, accumulates history), `instagram_media`, `instagram_sync_log`.

**Platform:** `profiles`, `user_activity`, `audit_log`, `alert_actions`, `apify_config` (single row, RLS-locked to service role, holds the Apify API token — same posture as `lightspeed_auth`).

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
- **Status map:** OPEN→Pending Approval; SENT/DISPATCHED→Ordered; RECEIVED/CLOSED→Fully Received; CANCELLED→Cancelled. **Partially Received is derived** whenever `0 < received_qty < ordered_qty` — so a short shipment stays visible as partial, even after Lightspeed closes it. To force-close a specific short order, set `closed_override` on the PO (checkbox "Close order (short receipt)" on the form; `beforeSave` also sets status=Fully Received immediately); the sync then holds it Fully Received and never reopens it (also protected in the cancellation-reconcile pass).
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
- Config: `statusField, statusOptions, searchKeys, orderBy, canWrite, stampCreatedBy, beforeSave, onChanged, filter, toolbarExtra, rowClickToEdit, rowLink(row)→route, extraFilters, groupBy, allowCreate, allowDelete(row), formExtra(row)`.

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
- **`src/pages/Instagram.tsx`** — Instagram performance, wired to the **Apify** pipeline (was originally built for the dead Meta path). Account switcher across the 3 tracked handles; reads `instagram_daily` (filtered to the selected account — do NOT mix accounts or the follower line zigzags) + `instagram_posts`. Cards: Followers (+30d), Following/posts, Avg engagement/post, Engagement rate. "Sync now" calls **`instagram-apify-sync`**. Top posts sortable by Engagement/Likes/Comments/Newest. Reach/impressions/saves intentionally absent (Meta-only).
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
| `instagram-connect` | true | Settings UI | Instagram OAuth connect (Meta path, dormant) |
| `instagram-sync` | false | cron + manual | Instagram insights via Meta Graph API (dormant — token never finished) |
| `influencer-followers-sync` | false | cron (weekly, all) + admin/manager/marketing JWT ("Refresh followers", per influencer via `{influencer_id}`) | Scrapes fresh follower counts for influencers via Apify → updates `influencers.followers`/`followers_updated` + records `influencer_follower_snapshots`. Extracts the IG username from @handle / profile URL / bare handle. **Fast-return + background**: the ~45s scrape runs via `EdgeRuntime.waitUntil`, the request returns `{started:true}` immediately, and the client polls `influencers.updated_at` for completion (a synchronous hold made the browser report "Failed to send a request"). |
| `instagram-apify-sync` | false | cron + admin/manager/marketing JWT | **Active IG tracker.** Scrapes 3 public accounts (timekeeperkw, timegallerykw, timekeeperkwshop) via Apify Instagram Profile Scraper → `instagram_daily` (followers, follows, last-post) **and `instagram_posts`** (per-post likes/comments/type/caption/hashtags). No login. Token from `apify_config`/`APIFY_TOKEN`. Async start-poll-fetch. Newest post = `max(timestamp)` (pinned posts float to top — never trust the first item). |

Auth for cron-callable syncs: `x-sync-key` header = `lightspeed_auth.sync_key`, OR an admin/manager JWT. Edge functions get **~150s wall clock** and PostgREST caps selects at 1000 rows — heavy syncs must batch/paginate and respect the deadline.

## 10. Cron jobs (pg_cron, UTC)

| Job | Schedule (UTC) | Kuwait | Calls |
|-----|----------------|--------|-------|
| `lightspeed-daily-sync` | `0 5 * * *` | 08:00 | `lightspeed-sync` |
| `lightspeed-po-sync` | `5 5 * * *` | 08:05 | `lightspeed-po-sync` |
| `instagram-daily-sync` | `15 5 * * *` | 08:15 | `instagram-sync` (Meta, dormant) |
| `instagram-apify-sync` | `20 5 * * *` | 08:20 | `instagram-apify-sync` (active) |
| `influencer-followers-weekly` | `0 6 * * 1` | Mon 09:00 | `influencer-followers-sync` (all influencers) |

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

- **2026-08-25** (later 4) — **My Portal full redesign** (`src/pages/MyPortal.tsx`) to a clean employee self-service dashboard answering four questions fast: am I clocked in? / attendance status / leave balance / pending requests. Four full-width bands: **(1) Header** — "My Portal" + a status line with a colour dot (Clocked in since… · late / Clocked out · time / Not clocked in / On leave today / WFH today). **(2) Today's Attendance** (strongest priority) — title + location + late/justified indicator, one dominant Clock In/Out button (only the valid action shows; live duration ticks every 30s via `nowMs`), a 3-value weekly summary (hours as `32h 12m`, days present, on-time days), a single IN/OUT/DURATION punch strip, "Expected by {grace}" and a quiet "Request a correction →". **(3) My Leave | My Requests** 50/50 — Leave shows Annual remaining as one big number + "X of Y used" progress bar (no repeated KPI boxes) with Sick separated below; Requests shows the latest 4 (View all → expands) as whole-row-clickable items (type, date, 2-line description, status pill) that expand to show remarks/document. Request WFH lives here. **(4) Personal & HR** full-width 4-column grid; missing values show "Not provided". One consistent status system (dot + text, never colour alone): Pending amber / Approved green / Rejected red / Cancelled grey. Buttons follow emphasis: Clock In/Out filled (≥52px), Apply for Leave / Request WFH outline, corrections/View all as quiet links; visible focus rings; skeleton loading + load-error "Try again" + empty states. Removed the right-side rail and the duplicated entitlement/taken/remaining KPI boxes.

- **2026-08-25** (later 3b) — New employee **Taha Shabbir Husain Kotawala** (Designer, Timekeeper HQ) added to `employees` from his Civil ID; login account left for admin to create in Settings (password step) then link.

- **2026-08-25** (later 3) — **Per-account Inbox** (`/inbox`, `src/pages/Inbox.tsx` + `src/lib/inbox.ts`): every account sees the pending items assigned to them. Available to all roles (like My Portal); a nav badge shows the open count. **Assigned to me** aggregates open items across modules matched by the account's name(s) — profile `full_name` and the linked employee `full_name`, case/space-insensitive — against each module's free-text assignee field: Content Planner (`owner`), Paid Ads (`owner`), Repairs (`assigned_to`), Influencer collaborations (`owner`), Follow-ups/`cases` (`staff`), Demand list & Pre-orders (`staff_responsible`), each filtered to non-terminal status and sorted by due date (overdue flagged). **Approvals waiting on me** (admin/manager/hr only): pending `leave_records` and pending `employee_requests` with inline Approve/Reject (requests take an optional remark) — this is also the first review UI for `employee_requests` (previously only submitted from My Portal, never reviewed). The My Portal blank-page fix, role-scoped dashboard, and this Inbox all apply to non-admin accounts.

- **2026-08-25** (later 2·fix) — **My Portal blank-page crash** fixed: the new `weekStats` `useMemo` was below the `if (loading) return` early return, violating Rules of Hooks — the hook count changed once loading flipped, crashing the portal to a blank page for signed-in users. Moved the hook above the early return.

- **2026-08-25** (later 2) — **My Portal dashboard tiles**: Today's Attendance card now leads with a **This week** summary row (hours worked, days present, on-time /days) computed from the current Kuwait week's own attendance records (Sat→now); leave balances redesigned as **bigger stat tiles** (3xl numbers, Remaining colored emerald/amber by threshold). Makes the portal read like a personal dashboard on desktop.

- **2026-08-25** (later) — **My Portal desktop layout**: widened from `max-w-3xl` to `max-w-6xl`; Today's Attendance stays full-width, then a 2-column grid (leave + action forms | requests + HR info) on `lg+`, single column on mobile. Fills the screen instead of a narrow left strip.

- **2026-08-25** — **Role-scoped dashboard**: the headline financial cards (Sales month/target, Supplier balance, Stock value) now render only if the role can access `/sales` / `/purchase-orders` / `/stock`; the **Store Daily Report** button is gated to `/sales`; the **Alerts & Actions** panel is admin/manager-only. A non-financial role (e.g. marketing) sees an empty headline + only its own sections (Marketing). My Portal: dedicated **Request WFH** quick button (pre-fills a WFH leave request for today; WFH was already a leave type).

- **2026-08-24** (later 4) — Attendance scoring: **overtime days (>8:10) ×2** and **short days (<6h) −3** added to `employee_scoreboard` + performance cards/leaderboard. **Team Attendance calendar** (List/Calendar toggle): **month** (default) or week grid of **all active employees** × days; flags **unexplained absences** (missed a working day — one where others clocked in — with no approved leave); month/week nav; per-period absence count; employees can be **hidden** (persisted in localStorage; unlinked "no account" rows are never flagged absent).


- **2026-08-24** (later 3) — Performance page: KPI cards are **clickable** (drill into /attendance, /activity, /history, /leave), and a new **Overall leaderboard** ranks everyone by **cumulative points** (`employee_scoreboard(since)` RPC, admin/manager-guarded): days present ×3 · on-time days ×2 · late −5 · full 8h days ×3 · overtime(8:10+) ×2 · short(<6h) −3 · active days ×2 · created ×3 · updated ×1. Click a row → that person's profile.
- **2026-08-24** (later 2) — **Identity unified + Employee Performance page.** Attendance/activity/audit all key off `user_id`; duplicate names (e.g. "Ali Akbar" vs "Ali Akbar Modi", trailing spaces) fixed by: trimming all names, backfilling `attendance_records.employee_name` to one canonical name per `user_id` (HR name if the account is linked, else login name), and a **`before insert` trigger `attendance_canonical_name`** so clock-ins can never drift again. User Activity now shows the same canonical (HR) name. New **`/performance`** page (admin/manager, nav Admin): pick a person + range → **Attendance** (days present, on-time %, avg hours/arrival, missed clock-outs, last clock-in), **App activity** (active days, page views, last active, top pages from `user_activity`), **Edits & input changes** (`audit_log` by `changed_by`: created/updated/deleted, top modules, recent list), and **Leave**. Note: `audit_log` rows from syncs have `changed_by = null`, so per-person filtering shows only human edits.

- **2026-08-24** (later) — **Dashboard simplified**: headline strip trimmed to 4 (Sales month vs target · Supplier balance · Stock value · Action alerts); each section cut to its 3 must-follow KPIs with a **View details →** link; section charts now **collapsed by default** behind a per-section **"Trends ▸"** toggle (`Section` gained `showCharts` state). ~39 cards → ~19.

- **2026-08-24** — Limited Projects Delivery column: a **Received/closed** project (or one with an actual delivery date) no longer shows red on a past expected date — `ExpiryCell` (which flags any past date "overdue") is only used while the delivery is still pending. Fixed the false-overdue on Cabochon Qatar.
- **2026-08-24** — Limited Watch Projects **audit fixes**: added **`delivered_date`** (set it → "✓ Delivered" badge, clears overdue = the delivery-confirmation gap); added **`updated_at`/`updated_by`** (BEFORE UPDATE trigger `set_row_updated_meta`); **tightened RLS write** to admin/manager/operations (was any authenticated user — UI-only restriction). Completed/Cancelled projects move to a collapsible "Completed & closed" section below the active list (and don't show overdue). Influencer profile: **"Refresh followers"** button (per influencer) + list **"Refresh all followers"** button + **weekly cron** (all) via new `influencer-followers-sync` edge function (Apify scrape → `influencers.followers` + snapshot). Handles **unified** to a clean bare IG username via `cleanHandle()` (applied on every save; displayed as `@handle`). "Completed" status added to Limited Watch Projects.

- **2026-08-02** (later 2) — **Influencer Tracker → two-level model.** New `influencers` (permanent profile) + `influencer_collaborations` + `influencer_follower_snapshots`; migrated the 25 flat `influencer_campaigns` rows (1→1 influencer+collab, legacy table kept). List page (`InfluencersPage`) row-click navigates to a full **profile page** `src/pages/InfluencerProfile.tsx` (`/influencers/:id`): header (photo, followers, 30d growth, country, contact, status, rating, Open-Instagram), performance KPIs (collabs, paid, gift, revenue, last collab, ROI), follower-growth chart (30/90d), a Collaborations CrudModule (+ Add), notes. Added `CrudConfig.rowLink`. Back button + browser Back return to the list.
- **2026-08-02** (later) — Rewired the **Instagram Performance page** to the Apify pipeline: "Sync now" now calls `instagram-apify-sync` (was the dead Meta `instagram-sync` → "non-2xx"); follower chart filtered per-account (fixes the zigzag from mixing 3 accounts); Top posts read `instagram_posts`; added a 3-account switcher; dropped Meta-only cards.
- **2026-08-02** — **IG post-level engagement** (Phase 3): `instagram-apify-sync` now stores per-post likes/comments/type/caption/hashtags into new `instagram_posts` (+ `follows_count` on `instagram_daily`). Dashboard Marketing gains an "Avg engagement / post" KPI (+ % of followers) and a "Top posts (30d)" widget for @timekeeperkw. Also: installed the **Agent-Reach** skill (`~/.claude/skills/agent-reach`) for on-demand web/social research — public data only, no private IG insights.
- **2026-07-30** — Reworked short-receipt handling after the 07-29 change went too far (it closed *all* short orders). Now: short orders show **Partially Received** by default (shortfall stays visible); a per-PO **`closed_override`** flag force-closes specific old ones. Restored the 6 genuinely-in-flight partials (MAI-2071/2100/2102/2107/2108/2138) and kept the 6 the owner closed (MAI-329/349/44/533/695/695[cont]). Added the "Close order" checkbox on the PO form.
- **2026-07-29** (later) — Dashboard "Stock value over time" chart now plots **cost** for admin/manager (title "Stock cost over time"), retail for staff — keeps the manager-only cost convention.
- **2026-07-29** — (superseded by 07-30) attempted fix for short-shipped closed POs stuck on Partially Received.
- **2026-07-27** (later) — **Instagram tracking via Apify** (replaces the never-finished Meta path for followers/cadence). New `instagram-apify-sync` edge function + daily cron scrapes 3 public accounts; `instagram_daily` made multi-account; `apify_config` table for the token. Dashboard Marketing section gains a 3-account comparison (followers · Δ today · last post · days idle) + main-account followers trend.
- **2026-07-27** — Fixed **cancelled POs never syncing**: Lightspeed's consignment list omits CANCELLED, so cancels were invisible. Added a reconciliation pass to `lightspeed-po-sync` that single-fetches vanished open POs (MAI-417 + 4 others were stuck). Also normalised the function source to ASCII.
- **2026-07-25** (later) — **Owner-view dashboard charts** added (`src/components/Charts.tsx`): 6 first charts across Sales, Stock & Purchasing, Repairs, Marketing sections. `Section` extended with a `charts` slot.
- **2026-07-25** — Created this reference. Added **Influencer Tracker** (`influencer_campaigns`, `/influencers`). Added **per-outlet sales targets** (Avenues, Time Gallery) in Settings + dashboard cards. Stock product view gained **Avg cost / Retail / Margin**. Fixed CrudModule NOT-NULL save error (read-only fields now stripped from payload) + paginated `load()`. PO page: **order number now from Lightspeed `reference`** + `supplier_invoice_no`; **3 summary cards** (Outstanding balance / Awaiting receipt / Awaiting invoice); **project-linked flag**; table slimmed to 8 columns. Historical/untracked received POs marked settled. `lightspeed-po-sync` deployed + daily cron.
- **≤2026-07-24** — PO source-of-truth migration (Lightspeed = master, lifecycle Pending Approval/Ordered/Partially Received/Fully Received/Cancelled, `purchase_order_items`, legacy matching). DSR follow-up log separation, per-day/outlet reports, staff yesterday-only. Media & Marketing section (Instagram sync, Content Planner, Paid Ads). HR: attendance, lateness rules, leave/sick/WFH, employee portal, geofences. Stock (Lightspeed) page + dashboard rebuild. Username-based access control, activity log, history log.
