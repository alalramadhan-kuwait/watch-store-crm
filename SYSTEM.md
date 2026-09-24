# Timekeeper — System Reference

> **Purpose of this file:** the single source of truth for how the Timekeeper systems fit together — architecture, data model, modules, integrations, conventions. It is the reference Claude reads before making changes, and **it must be updated in the same change whenever the system changes** (new module, table, edge function, cron job, role, convention, or a notable fix). Keep the Changelog at the bottom current.
>
> **This is a mirror.** The same file lives in both repos (`timekeeper-online/SYSTEM.md` and `watch-store-crm/SYSTEM.md`) because the two apps share one system — keep the two copies identical when you update either.
>
> Last updated: **2026-09-24**

---

## 1. Overview

Timekeeper is a Kuwait watch retailer. Two connected web apps run the business, **sharing one Supabase project**:

| App | Repo | Role | Hosting |
|-----|------|------|---------|
| **Timekeeper Online** | `timekeeper-online` | Operations control: purchasing, stock, HR, marketing, dashboards | GitHub Pages |
| **Daily Store Report (DSR)** | `watch-store-crm` (`../watch-store-crm`) | The shop floor's app: customer visits, follow-ups, customers and WhatsApp, per-outlet daily reports, and each person's own portal and requests | GitHub Pages |

**Boundary rule (memorise this):**
- Customer visits, follow-ups, a salesperson's customers, closing the day → **DSR**. The customer record itself is shared: both apps show it, under the same rules (§4).
- Everything operational — purchasing, stock, HR, marketing, targets, dashboards → **Timekeeper Online**.
- Anything that scans at the register or changes stock count → **Lightspeed** (POS, source of truth for stock and POs).
- A promise, a payment owed, a person, or an expiry date → **Timekeeper Online**.

**Outlets:** Timekeeper HQ, **Avenues**, **Time Gallery** (stored in `cases.outlet` as `Avenues` / `TimeGallery`), plus two channels that sell but have no premises, **Online** and **WhatsApp**. Every spelling of every one of them resolves through the registry (§10a).

**Versions:** each app carries one, shown under its title with the build; see CLAUDE.md → Releases. Tags `vX.Y.Z` mark where each first shipped.

---

## 2. Tech stack

- **Frontend:** React 18 + TypeScript + Vite + TailwindCSS, **HashRouter** (required for GitHub Pages).
- **Backend:** Supabase — PostgreSQL + RLS, Edge Functions (Deno), pg_cron + pg_net, Storage buckets, Auth.
- **Supabase project ref:** `ttshgrujnycapugrmyxs` (shared by both apps).
- **Integrations:** Lightspeed X-Series (POS: stock, POs, and since 2026-09-21 every sale and customer), Meta Graph API (ads), Apify (Instagram, active; the Graph API path is dormant), Resend (email, parked). WhatsApp is reached only through `wa.me` links a person sends from their own phone — there is no WhatsApp API.
- **Locale:** `Asia/Kuwait` (UTC+3); week starts Saturday; currency KD, 3 decimals.
- **Deploy:** automatic. Every push to `main` is typechecked and built by GitHub Actions (`.github/workflows/ci.yml`) and, only if that passes, published to the `gh-pages` branch that Pages serves. **Nothing is deployed from a laptop** — `npm run deploy` now refuses, on purpose: a stale checkout once overwrote the live site with an older build. To ship, commit and `git push origin main`; the site follows in ~1–2 minutes. The DSR shows `v{version} · {short sha}` so staff can tell which build reached their phone; bump `package.json` version by hand only when it means something to people. Commit messages end with the Co-Authored-By trailer.

---

## 3. Frontend architecture

- **`src/App.tsx`** — routes (HashRouter). Every guarded route wraps in `g(path, element)` = `canAccessPath` check.
- **`src/components/Layout.tsx`** — nav groups + `PAGES` catalogue + `canAccessPath(to, role, pageAccess)`; activity logging on route change. `<main>` is full width (`w-full`, no max-width).
- **`src/context/AuthContext.tsx`** — `useAuth()` → `{ user, profile, role, pageAccess, loading, signIn, signOut }`.
- **`src/components/CrudModule.tsx`** — the generic CRUD engine most pages are built on. See §7.
- **`src/components/ui.tsx`** — `Card`, `Badge`, `StatusBadge`, `Modal`, `Spinner`, `statusColors`.
- **`src/lib/`** — `supabase.ts`, `format.ts` (`formatKD`, `formatKDCompact`), `expiry.ts` (`expiryTier`/`tierClass`/`tierLabel`), `lateness.ts`, `locationType.ts`, `activity.ts`, `alerts.ts` (`buildAlerts`), `customers.ts` (the CRM's calls).
- **`src/shared/`** — rules both apps must agree on, mirrored byte for byte. See §10a.

### Nav groups (Layout.tsx) & routes

| Group | Pages (route → label) |
|-------|-----------------------|
| (top) | `/` Dashboard · `/me` My Portal · `/inbox` Inbox · `/notifications` Notifications |
| Sales & Customers | `/sales` · `/crm` CRM Customers · `/follow-ups` Follow-up Board · `/vip` · `/waiting-list` Demand List (waiting list and pre-orders on one page; `/pre-orders` is an alias kept so old links resolve) |
| Purchasing & Stock | `/purchase-orders` Supplier Payments · `/stock` Stock (Lightspeed) · `/consignments` · `/limited-projects` · `/repairs` |
| HR & Team | `/attendance` · `/hr` Employees · `/leave` |
| Media & Marketing | `/instagram` · `/content` Content Planner · `/paid-ads` · `/meta-campaigns` · `/influencers` (+ `/influencers/:id` profile) |
| Admin | `/tasks` Assign Tasks · `/activity` User Activity · `/performance` Employee Performance · `/history` History Log · `/notification-settings` · `/settings` |

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

### Effective permissions

What each role can actually do, after both layers. The UI can only ever be
*stricter* than RLS — anything in this table is what the database allows, so a
page hidden from somebody is not a security boundary on its own.

| | admin (Owner) | manager | hr | sales / staff | operations / marketing | viewer |
| --- | --- | --- | --- | --- | --- | --- |
| Every page | yes | all but admin-only bits | HR pages | portal only, by default | their own module | read-only pages |
| Settings → Team Access | yes | yes, but cannot touch an admin | no | no | no | no |
| See all employees | yes | yes | yes | own record only | own record only | own record only |
| Edit an employee / schedule | yes | yes | yes | no | no | no |
| See all attendance | yes | yes | yes | own only | own only | own only |
| Correct an attendance record | yes | yes | yes | request it | request it | no |
| Decide a request (leave, correction, schedule change) | final approval; may override a waiting manager with a written reason | first approval, in their `manager_scopes` locations, not their own | final approval | raise; edit or withdraw own while Pending | raise; edit or withdraw own while Pending | no |
| Log a DSR visit | yes | yes | no | yes | no | no |
| Edit a DSR entry | any | in their scope's outlets | no | own, unlocked; an open follow-up that is theirs (the shared login: any open follow-up) | no | no |
| Read DSR entries | all | their scope's outlets | no | every outlet's today and yesterday, plus any entry for a customer of theirs | no | no |
| See a customer's number on an entry | yes | their scope's outlets | no | their customers', and a personal login's own entry today | no | no |
| See a customer and their history | everyone | customers of their scope's outlets | no | customers they have served (the shared login: none) | no | no |
| Assign a customer's responsible salesperson | yes | their scope | no | no | no | no |
| Send a WhatsApp handoff | yes | their scope | no | their customers (the shared login: as the salesperson it names) | no | no |
| Edit message templates | yes | no | no | no | no | no |
| Change an outlet in the registry | yes | yes | no | no | no | no |
| Financials on the Dashboard | yes | yes | no | no | no | no |

Notes that are easy to get wrong:

- **`page_access = null`** means role defaults; **`page_access = '{}'`** (an
  explicit empty list) means the always-on pages only — Dashboard, My Portal,
  Inbox, Notifications. An empty list is a real answer, not "unset".
- **`/settings` is never grantable through `page_access`.** It stays role-gated
  to admin and manager, because it is where accounts are made.
- **Leave approval is two steps** and a manager cannot give the first approval
  on their own leave (`can_give_first_approval` excludes `e.user_id = auth.uid()`).
- **Five tables have RLS on and no policy at all** — `app_config`,
  `apify_config`, `push_config`, `instagram_auth`, `lightspeed_auth`. That is
  deliberate: they hold credentials and are reachable only by the service role,
  from edge functions and cron.
- **Realtime respects RLS**, so a salesperson subscribed to `attendance_records`
  receives their own rows and nobody else's.
- **Who may see which customer** is decided by a relationship, not a role
  (2026-09-21). `customer_relationships` holds one row per salesperson and
  customer they have served — a DSR entry under their roster name, a Lightspeed
  sale credited to them, a manager's assignment, a WhatsApp handoff — rebuilt by
  triggers on every change and again nightly, so a corrected entry takes its
  access away with it. The rules and their reasoning are in
  `supabase/README.md` → *Who may see whom*; the helpers are listed in §5.
- **Today's outlet isolation is the app's, not the database's.** A floor login
  may read every outlet's entries from today and yesterday; the DSR filters to
  the outlet chosen at sign-in, because a shared phone cannot tell the database
  which shop it is standing in. Temporary until every salesperson has a
  personal login; do not describe it as database-enforced.
- **The shared shop login is nobody.** It sees no customers, cannot send a
  WhatsApp handoff or record an outlet change in its own name, and must name
  the salesperson (`attributed_employee()`); `via_shared_device` records that it
  did.

`profiles` columns: `id, full_name, role, page_access (text[]|null), sales_name (text|null), created_at, updated_at`. There is **no username column** — login identity is the auth email. `page_access = null` means default role-based access; **`page_access = '{}'` (empty list) means the always-on pages only** (Dashboard, My Portal, Inbox, Notifications) — used for salespeople. **The DSR roster name** — the name this login's sales are logged under (`cases.staff`) — lives on **`employees.dsr_staff_name`**, not on the profile. `profiles.sales_name` is a deprecated mirror kept in step by the `employees_sync_sales_name` trigger, read only for an account with no employee record linked. `get_my_sales_name()` prefers the employee record and falls back to the mirror. It must equal an entry of `settings.staff_roster` and is set in Settings → Team Access ("DSR name", via `admin-users` `update`), which writes the employee record. `null` = shared login / not a salesperson. It was stored in two places with nothing syncing them, which locked a salesperson out of the DSR when only one was filled.

**Floor roles: `staff` and `sales` are interchangeable** (since 2026-09-13). `staff` is the shared shop login, `sales` a personal one; both may insert cases and close a day (`cases` INSERT/UPDATE + `day_closes` INSERT admit `admin|staff|sales`, migration `20260913180000_sales_role_can_log_cases.sql`), and the DSR gates on `isFloorRole()` / `useAuth().onFloor`, never on the literal `'staff'`. Before that, an account created with the obvious role `sales` could open the app and be refused on save — and, because the outlet gate also keyed on `'staff'`, it was never asked for an outlet and wrote `outlet = null`.

**A salesperson with their own login = four things**, all set from the UI (repeat per person): (1) Team Access → Add account, role **`staff` or `sales`** (both work); (2) Team Access → edit → **DSR name** = their roster name (keeps history continuous when the login name differs, e.g. login "Fadi Hussain" logs as "Fadi"); (3) Team Access → access → Custom with nothing ticked = portal only; (4) HR → Employees → **Linked user account** + Location — My Portal, leave and attendance all hang off this link (RLS `own_read_emp`); the outlet is *not* taken from it, everyone picks their outlet at each login. Clock-in additionally needs a **geofence** named exactly like the HR location (`Time Gallery`, `Avenues`; `Timekeeper HQ` exists).

---

## 5. Database — tables

Public base tables (Supabase project `ttshgrujnycapugrmyxs`):

**Sales / CRM (shared with DSR):** `cases` (has `outlet`, `case_type`, `amount_kd`, `date_logged`, `deleted`, `sale_items(amount_kd)`; since 2026-09-21 also `customer_id` → `customers`, set by the `cases_link_customer` trigger from the number; `interaction_at`, when the customer was actually there, which the DSR lets somebody correct — `created_at` is when it was saved; and `contact_declined`, a Lost Opportunity whose customer would not give a number), `sale_items`, `customers`, `day_closes`, `brands`, `settings`. **Read `cases` through the `cases_visible` view**, never the table: it applies who may see which entry and blanks a customer's number where the reader may not see it (`contact_masked`).

**Customers (2026-09-21):** `customers` is the customer record, one per number. `phone_e164` is generated from `contact` by `normalize_phone()` and unique; `contact` is kept in the local form people type. The `customers_guard_identity` trigger normalises on the way in, refuses a non-number, refuses a number another customer holds, refuses to change a number Lightspeed holds (correct it at the till; it syncs within ten minutes) and writes every change to **`customer_contact_changes`**. Also `responsible_employee_id` (+ `_assigned_by`, `_assigned_at`; only a manager or admin may set it), `anniversary`, `lightspeed_customer_id`. **`customer_occasions`** (label, month, day, optional year) holds dates beyond birthday and anniversary. Three caches decide visibility and are rebuilt by triggers on every relevant change and nightly by `customer-caches-rebuild`: **`sale_credits`** (which employee a Lightspeed sale counts for: line-item salesperson first, then the till user), **`customer_relationships`** (employee ↔ customer, with `source` entry / lightspeed / assignment / crm_action) and **`customer_outlets`** (which outlets a customer has been seen at, for manager scope). All three are admin-read only; everything else reaches them through definer functions (§5 functions). **`message_templates`** (key × `en`/`ar`, admin-edited, everyone reads) and **`whatsapp_handoffs`** (that an employee opened WhatsApp to a customer with a template — never the conversation; `via_shared_device` and `created_by` keep which login did it). **`outlet_changes`** records a salesperson moving shop mid-shift, linked to the open attendance record.

**Purchasing & stock:** `purchase_orders`, `purchase_order_items`, `consignments`, `limited_projects`, `waiting_list`, `pre_orders`, `repair_watches`, `lightspeed_auth`, `lightspeed_stock`, `lightspeed_stock_cost`, `lightspeed_product_sales`, `lightspeed_stock_value_history`, `lightspeed_sync_log`.

**Lightspeed transactions (2026-09-21):** every till sale, not just daily totals. **`lightspeed_sales`** (one row per sale: outlet, register, till `user_id`, `customer_id`, status, `return_for`, totals incl. tax, `sale_date`/`sale_day` in Kuwait time, `version`, `payments` jsonb, and `scope_code`, the canonical outlet or channel the sale belongs to, set by the `lightspeed_sales_scope` trigger), **`lightspeed_sale_items`** (line items, with `salesperson_id` — Lightspeed's per-line salesperson, which is preferred over the till user), **`lightspeed_customers`** (Lightspeed's customer records, `phone_e164` generated the same way as ours, matched to `customers` by number and never merged into it), **`lightspeed_users`** (every till login mapped to `kind` employee / channel / unassigned — `employee_id` or `channel_code` — so a sale can be credited to a person), **`lightspeed_sync_state`** (the incremental sync's cursor per kind, `caught_up`, `last_error`). `lightspeed_sync_log` gained `kind` (stock / sales / reconcile). Statuses that count as a sale are `lightspeed_sale_counts()`: VOIDED and SAVED are not sales. The aggregate tables (`lightspeed_sales_daily`, `lightspeed_sales_by_staff`) are untouched and remain what reporting reconciles to.

**HR:** `employees`, `attendance_records`, `leave_records`, `employee_requests`, `geofences`, `company_documents`, **`employee_schedules`** (2026-09-17: dated working days and shift times — `effective_from`/`effective_to`, `working_days smallint[]` in Postgres dow numbering, no-overlap exclusion constraint; `employees.expected_days`/`shift_start`/`shift_end` are a mirror of whichever row is in force *today*, kept by trigger, and must not be used to judge a past date).

**Requests (2026-09-18):** `leave_records` and `employee_requests` share one approval spine — `manager_status` + `manager_decided_by/_at`, `final_decided_by/_at`, `override_by/_at/_reason/_stage` (an owner settling something a manager has not, which needs a written reason and says which stage it skipped), `on_behalf_by`, `withdrawn_at`. `employee_requests` also carries the times a correction proposes (`attendance_date`, `proposed_clock_in/_out`, `attendance_record_id`, `applied_at/_by`) and a schedule change's (`proposed_from/_until/_days/_shift_start/_shift_end`). Nothing is hard-deleted: a withdrawn or rejected request stays. `workflow_guard()` decides every transition and the stage is read, never computed, through **`v_requests`**. **`request_reminders`** records every nudge, manual or automatic, which is what enforces the four-hour cooldown. `employee_schedules.grace_minutes`: null = the company default (`settings.late_grace_minutes`), 0 = the shift start is the deadline.

**Outlets:** **`outlets`** (2026-09-17: the canonical registry — `code`, `display_name`, `kind physical|digital`, `sells`, `has_attendance`, `has_geofence`, `tracks_store_day`, `geofence_name`, `pos_names[]`, `dsr_names[]`, `aliases[]`). See §10a. Since 2026-09-18 also `opens_at` / `closes_at` for the two shops — the one thing true for everyone on the floor however their shifts are assigned, used to close a shift nobody clocked out of.

**Marketing:** `content_tasks`, `paid_ads`, **`influencers`** (permanent profile: name, handle, platform, tier, country, followers, followers_updated, contact, photo_url, status [Active/Prospect/Paused/Inactive], rating, notes) + **`influencer_collaborations`** (one row per collab, FK influencer_id: campaign, product_brand, product, collab_type [Paid/Gift/Affiliate/Event], platform, coverage, deliverables, agreed/posted dates, fee, amount_paid, gift_value, attributed_revenue, payment_status, status, engagement, owner, notes) + **`influencer_follower_snapshots`** (influencer_id, snapshot_date, followers — for the growth graph & 30/90d deltas). `influencer_campaigns` = **legacy** flat table, migrated into the above (1 row → 1 influencer + 1 collab), kept for rollback. `instagram_auth`, `instagram_daily` (**multi-account**: PK `(snapshot_date, username)`, cols incl. `followers`, `follows_count`, `last_post_date`, `media_count`; `reach`/`impressions`/`profile_views` only fillable by the Meta path, null from the scraper), `instagram_posts` (per-post engagement: PK `shortcode`, cols `username, posted_at, type, likes, comments, video_views, caption, hashtags[], url`; last ~12 posts/account refreshed daily, accumulates history), `instagram_media`, `instagram_sync_log`. **Meta Ads (2026-09-16):** `meta_ads_config` (one row: account id, currency, `last_synced_at`, `last_error`, `kwd_per_usd` + `rate_updated_at`), `meta_ad_campaigns` (Meta's campaign records, PK = Meta's id), `meta_ad_insights` (PK `(campaign_id, period, date_start, date_stop)`, `period` in `lifetime`/`daily`). **Every figure column there is TEXT on purpose** — spend/impressions/reach/clicks/ctr/cpc/cpm are the exact strings Meta sent, and a numeric column would invite the database to round them. `actions` keeps Meta's whole array so "Results" can be picked per objective at display time. `paid_ads.meta_campaign_id` links a tracker row to a campaign; null = not linked. Nothing writes a Meta figure into `paid_ads`. **`meta_campaign_brands`** (2026-09-16) holds the brand a campaign was for, stated by a person: one row per `(campaign_id, brand_id)` so a campaign may carry several brands, or a single row with `brand_id` null and `kind` `whole_shop`/`unknown` meaning it has none. No row at all = nobody has said, which falls back to name-reading. Two partial unique indexes plus a trigger stop a campaign holding both brands and a "no brand" marker — that combination would make the brand split add up to more than the spend.

**Platform:** `profiles`, `user_activity`, `audit_log`, `alert_actions`, `apify_config` (single row, RLS-locked to service role, holds the Apify API token — same posture as `lightspeed_auth`). `audit_log.actor_kind` (2026-09-18) says whether a row was written by a person or by the system, so a change with no `changed_by` reads as "system" rather than as an unknown person. `notifications.audience_outlet` and `notification_settings.shop_floor` / `.outlet_scoped` (2026-09-18/19) — see *Notifications* at the end of this section.

**Watch Design Studio (separate repository, same database):** `watch_designs` (named designs per person, `deleted_at` as a tombstone so a delete propagates across devices), `watch_design_versions` (earlier states: `auto`, `milestone` which is never thinned, `pre-restore`), `watch_design_assets` (uploaded files; the bytes live in the `watch-assets` storage bucket). Every policy is own-rows only. The studio moved out of this repo on 2026-09-12. **Its four migrations (20260920094846 – 20260921102836) are in neither this repo's `supabase/migrations/` nor the DSR's**, so these folders alone cannot rebuild those tables.

### `settings` (single row) — dashboard config
`sales_target_month`, `sales_target_avenues`, `sales_target_timegallery` (per-outlet monthly targets), `sales_target_online` / `sales_target_whatsapp`, plus brand list, `work_start_time` / `work_end_time` (the office's day and the fallback for anybody with no schedule) and `late_grace_minutes` (the company grace, one hour), etc.

### `purchase_orders` — see §6.1 for the full lifecycle. Key columns:
`ls_consignment_id` (unique; null = manual/legacy), `source` ('lightspeed' | 'manual'), `po_number` (= Lightspeed **reference**, e.g. `MAI-1234`), `supplier_invoice_no`, `supplier`, `brand`, `outlet`, `created_date`, `expected_arrival`, `status`, `item_count`, `ordered_qty`, `received_qty`, `total_cost` (all NOT NULL with defaults), `amount_paid`, `payment_status` (Unpaid|Partial|Paid), `payment_date`, `payment_method`, `invoice_received`, `team_notified`, `notes`, `linked_project`, `merged_into` (self-FK → the synced PO a legacy row folded into), `match_candidate_id` (uuid FK → suggested match), `ls_synced_at`.

### Views (`security_invoker = true` unless noted)
- `attendance_shifts` — one row per attendance record with its worked hours and
  its canonical `outlet_code`. `hours` is **null** when the record cannot answer
  the question: never clocked out (open more than `attendance_abandon_hours()`,
  16), or clocked out before clocking in.
- `attendance_day_hours` — one row per employee per Kuwait day. Split shifts are
  summed; `unusable_shifts` counts records needing a correction first.
- `pos_channel_sales` — till revenue by canonical channel and Kuwait day. **Sums
  back to `lightspeed_sales_daily` exactly**, so no sale is dropped or
  double-counted. `attributed = false` marks a remainder the salesperson could
  not be established for (days before Lightspeed's 90-day window, or a sale with
  no till user); it still lands in the register's catch-all channel.
- `cases_visible` (2026-09-21) — `cases` as the reader may see it: the rows
  `cases_visibility` admits, with `contact` blanked and `contact_masked = true`
  where `can_see_case_contact()` says no. **Both apps read entries through this
  and write to `cases`.** A blanked number on your own entry from today is
  fetched for editing through `case_contact_for_edit()`.
- `v_requests` (2026-09-18) — every leave record and employee request in one
  shape, with everything either inbox needs already resolved: `stage_owner`
  (who it is waiting on), names, the attendance on record beside the proposed
  times, `changes_nothing` (a correction asking for what is already recorded),
  and reminder state. Neither app computes a stage of its own.
- `lightspeed_sales_reconciliation` (2026-09-21) — per Kuwait day, the sum of
  transactions against `lightspeed_sales_daily`. `lightspeed_reconcile(days)`
  summarises it; the nightly job logs the result.
- `customer_relationship_sources`, `customer_outlet_sources` (2026-09-21) —
  what the relationship and outlet caches are rebuilt from. **Owner-rights views
  with no grant to signed-in or anonymous users**; only the definer rebuild
  functions read them.
- `lightspeed_low_stock` (stock at or under its reorder point),
  `lightspeed_stock_summary` (stock by product with 90-day sales),
  `purchase_order_items_view` (PO lines with name, SKU and brand filled from
  stock when the line lacks them), `user_activity_summary` (last active and
  7/30-day page views per user).

### DB functions (security definer, service_role/authenticated)
- `get_my_role()` — role of the calling user, used by RLS.
- `get_my_sales_name()` — the DSR roster name, from `employees.dsr_staff_name`,
  falling back to the deprecated `profiles.sales_name` mirror.
- `outlet_key(text)` / `resolve_outlet(text)` — any historical outlet spelling to
  its canonical code, or null. **Compare outlets through this, never with `=`.**
- `schedule_on(employee, date)` — the schedule in force on that date.
- `set_schedule(employee, from, to, days, start, end, note)` — change a schedule
  from a date, optionally until one. Closes the row in force, opens the new one
  and restores what a temporary change interrupted, in one transaction. HR,
  manager or admin only.
- `resolve_channel(pos_outlet, salesperson)` — the canonical channel a till sale
  belongs to, from the register **and** who rang it up. Falls back to
  `resolve_outlet()` for a register serving one channel.
- `pos_splits_by_staff(outlet)` — true when a register serves more than one
  channel and needs the salesperson to tell them apart.
- `store_day(outlet, date)` — when a shop opened and closed, from attendance.
  **Returns no row** for a digital channel or the office. Aggregates only, so a
  salesperson can see the shop is open without reading anybody's attendance.
- `po_match_legacy()` — auto-merges legacy POs onto their Lightspeed twin on exact `po_number` match (carries payment history, sets `merged_into`); records weaker matches as `match_candidate_id`. Returns `(auto_linked, suggested)`.
- `po_fill_brands()` — fills a synced PO's `brand` from the dominant-value product on it (leaves hand-set brands alone).
- `po_summary()` — JSON for the PO dashboard cards: `owed_kd, owed_count, receipt_count, receipt_kd, invoice_count` (excludes merged/cancelled; live obligations only).
- `kuwait_today()`, `kuwait_day_of(ts)` — the calendar day in Kuwait. Use these,
  never `current_date`: the server runs in UTC, so between 21:00 and midnight
  UTC it is already tomorrow in Kuwait.
- `next_case_id(date)` — the next `YYYYMMDD-NNN` DSR entry id.
- `admin_update_case(id, updates)`, `admin_soft_delete_case(id, audit)` — the
  owner's edits to a DSR entry, including on a closed day.

**Requests (2026-09-18).** `workflow_guard(...)` decides every transition on
both request tables — staging on every insert whoever makes it, who may decide
which stage, the owner's override needing a reason — and is called by the
`leave_two_step_guard` / `emp_request_two_step_guard` triggers. `stage_owner()`
names who a request is waiting on. `request_needs_manager(employee)` /
`leave_needs_manager()` say whether a first approval applies (not for the
managers themselves). `request_in_my_scope()` / `req_row_in_my_scope()` scope a
manager's reads and decisions. `apply_schedule_change(request)` applies an
approved schedule change through `set_schedule`, so it cannot read Approved
beside an unchanged rota. `remind_request(source, id, automatic)` sends one
nudge to whoever is holding a request up, refusing another inside four hours;
`remind_overdue_requests()` runs it for anything waiting over a day.
`attendance_on_day(user, date)` is what a correction is compared against.

**Customers and who may see them (2026-09-21).** Identity: `normalize_phone(text)`
(E.164, Kuwait by default, international numbers kept, anything else null —
mirrored by `src/shared/phoneRules.ts`), `customers_guard_identity` (trigger).
Who is who: `my_employee_id()`, `my_scope_codes()` (a manager's outlets and
channels, from `manager_scopes` through the registry). Visibility, all
set-returning definer functions so a policy evaluates them once per query:
`my_related_customers()`, `my_scope_customers()`, `my_credited_sales()`, and
the per-row tests `is_related_to()`, `customer_in_my_scope()`,
`can_see_case_contact()`, `ls_customer_visible()`. Caches: `refresh_sale_credits()`,
`refresh_customer_caches()`, and the `trg_*_refresh` triggers on `cases`,
`customers`, `lightspeed_sales`, `lightspeed_sale_items`, `lightspeed_customers`
and `whatsapp_handoffs`. `cases_link_customer` (trigger) links an entry to its
customer by number. One-off imports, safe to re-run: `customers_from_lightspeed()`,
`customers_birthdays_from_lightspeed()`.

**The shop floor's questions (2026-09-21).** Each answers under the caller's own
rules. `customer_by_phone(phone)` — as a number is typed: invalid / new / known
and yours (name and a line of history) / known and somebody else's (only
"recognised"). `customer_list()`, `customer_profile(id)`, `customer_known_by(id)`
— the Customers list and page. `lightspeed_today(outlet)` — the till's count
for an outlet today, limited to the sales the caller may see.
`roster_employees()` — roster name → employee id, the one thing about the team
every login may ask (the shared phone needs it to name a salesperson).
`log_outlet_change(to, from, employee)`, `log_whatsapp_handoff(customer,
template, lang, employee, case)` — record those actions; `attributed_employee()`
decides whose name goes on them and refuses the shared login unless it names
somebody. Templates: `render_template(body, vars)` / `message_for(key, lang,
vars)`, mirrored by `src/shared/messageRules.ts`.

**Occasions (2026-09-21).** `next_occurrence(month, day)`,
`upcoming_occasions(days)` (invoker), `occasion_recipients(customer)` (one
person: the responsible salesperson, else whoever served them last, else the
shop's manager), `occasion_reminders_due(lead_days)`,
`raise_occasion_reminders()` (the daily job; once per occasion per lead day).

**Lightspeed (2026-09-21).** `lightspeed_token_lease()` / `lightspeed_token_store()` /
`lightspeed_token_release()` — one job at a time may refresh the access token
(`lightspeed_auth.refresh_lock_until`); see §6.3. `lightspeed_sale_counts()`,
`lightspeed_reconcile(days)`, `lightspeed_reconcile_log()`.

Trigger functions not named above (`trg_*_notify`, `set_updated_at`,
`tko_set_updated_at`, `set_row_updated_meta`, `handle_new_user`,
`sync_sales_name_to_profile`, `sync_employee_schedule_columns`, the
`*_guard` triggers, `lp_*`, `watch_design*`) do what their names say; read
their definitions before changing the tables they sit on.

### Notifications

`notify_event(event, title, body, url, roles, person, exclude, dedupe, outlet)`
writes a row to `notifications`, which is both the history and the send queue.
`notify-flush` runs every 30 seconds and delivers what is due; batching and
quiet hours come from `notification_config` (08:00–22:00 Kuwait, 30-second
batches). Per event type, `notification_settings` holds whether it is enabled,
its audience roles, whether it goes to a named person, and two flags added in
September: **`shop_floor`** — the types a store manager can act on from a shop,
which is all the DSR's bell shows (leave and request events, `task_new`,
`occasion_due`); and **`outlet_scoped`** — types that must carry an
`audience_outlet`. For those, a manager sees only their own outlets, and a
missing outlet reaches **no** manager rather than all of them
(`notification_in_my_scope()`). Reads are per user in `notification_reads`.

**`notify_event` must never be given a second signature.** Adding a defaulted
parameter with `CREATE OR REPLACE` creates an overload, not a replacement, and
every existing eight-argument call then matches both and fails. That is how
clocking in broke on 2026-09-18. Drop the old signature in the same migration.

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


### 6.3 Every sale, and who the customer is (`lightspeed-sales-sync`, 2026-09-21)
Every ten minutes the sync pulls what changed since its last cursor from
Lightspeed's versioned endpoints (`/api/2.0/sales?after=`, `/customers?after=`)
into `lightspeed_sales`, `lightspeed_sale_items` and `lightspeed_customers`
(§5). `lightspeed_sync_state` holds each cursor and whether it has caught up.

- **One job refreshes the token.** Lightspeed rotates the refresh token on every
  refresh, so two jobs refreshing at once lock the system out. All three
  Lightspeed functions get their token through
  `supabase/functions/_shared/lightspeedAuth.ts` (`lightspeedToken`, `lsGet`,
  `callerAllowed`): the first to find it expired takes a lease
  (`lightspeed_token_lease()`, `lightspeed_auth.refresh_lock_until`), refreshes
  and stores it; the others wait and use the new token. Proved in production on
  2026-09-23, when the stock and sales jobs started in the same minute on an
  expired token.
- **Lightspeed dates year zero.** Unset dates arrive as `0000-12-30`; the sync
  turns them into null (`validDate` / `validTs`) rather than failing the batch,
  which is what the only three failed runs so far were.
- **Who a sale counts for** (`sale_credits`): the line item's salesperson first,
  then the till user, mapped to an employee or a channel through
  `lightspeed_users`; otherwise unassigned. A register that serves two channels
  is split the same way §10a describes.
- **Customers are matched, not merged.** A Lightspeed customer and ours are the
  same person when their `phone_e164` agree. `customers_from_lightspeed()`
  created a customer record for every Lightspeed customer with a usable number;
  foreign numbers without a country code are left unmatched rather than guessed.
- **Reconciliation.** `lightspeed_reconcile(days)` compares the transactions
  with `lightspeed_sales_daily` day by day; `lightspeed-reconcile` logs it every
  morning. On 2026-09-23: 140 of 140 days matching, to the fils. A day that
  stops matching means the transaction sync has lost or double-counted a sale.
- **`lightspeed-probe`** is a disabled stub (it answers 410) left from the
  read-only probe that preceded this. It cannot be removed through the tools;
  delete it from the Supabase dashboard under Edge Functions.

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
- **`src/pages/MyPortal.tsx`, `Attendance.tsx`, `Leave.tsx`** — employee portal, clock-in/out, leave/sick/WFH requests. **Lateness and leaving early are judged against the schedule in force on that date** (`src/shared/punctuality.ts`), not a fixed 9-to-5: the person's own shift, with the shift's own grace if it sets one, else the company grace (`settings.late_grace_minutes`, one hour); a schedule with no hours means *hours vary* and nothing is claimed; only somebody with no schedule at all falls back to the office day, marked "default hrs". HR → Attendance shows hours late and hours left early, with This month / Last 30 days / Last month, and a name opens into the days behind its totals.
- **`src/pages/Inbox.tsx`** (2026-09-18) — every request in one queue with three tabs, **Action required / Waiting on manager / Completed**, the tab decided by `v_requests.stage_owner` (`tabOf()` in `src/shared/requests.ts`); the same request is Action for the store manager and Waiting for the owner at once. A correction shows what is on record beside what is asked for. **Remind** nudges whoever it is waiting on; the owner's **override** of a waiting manager opens a dialog that will not submit without a reason.
- **`src/pages/Performance.tsx`** — per-employee cards, including hours late and hours left early from the same engine as HR → Attendance, so the two cannot disagree; on-time rate counts only days that could be judged.
- **`src/pages/Crm.tsx`** (2026-09-21) — **CRM Customers**: the list from `customer_list()` and each customer's page from `customer_profile()` — visits, Lightspeed purchases and WhatsApp handoffs on one timeline, details, occasions, number changes (refused in the database's own words when not allowed), the responsible salesperson for managers and owners, and WhatsApp. What each login sees is the database's decision (§4). `src/lib/customers.ts` holds the calls, shaped like the DSR's.
- **`src/pages/FollowUps.tsx`** — the follow-up board; a WhatsApp button per row (2026-09-21). Opening WhatsApp records a handoff and never marks a follow-up contacted — the status dropdown is still where that is decided.
- **`src/components/WhatsAppSheet.tsx`** — the template picker used by both of the above: English or Arabic, filled in and editable before WhatsApp opens with it typed. The owner must name the salesperson the message is from.
- **`src/components/WhatsNew.tsx`** (2026-09-23) — the version and build line in the menu and the phone header; tapping it opens the release notes from `src/releases.json`. See CLAUDE.md → Releases.
- **`src/pages/Instagram.tsx`** — Instagram performance, wired to the **Apify** pipeline (was originally built for the dead Meta path). Account switcher across the 3 tracked handles; reads `instagram_daily` (filtered to the selected account — do NOT mix accounts or the follower line zigzags) + `instagram_posts`. Cards: Followers (+30d), Following/posts, Avg engagement/post, Engagement rate. "Sync now" calls **`instagram-apify-sync`**. Top posts sortable by Engagement/Likes/Comments/Newest. Reach/impressions/saves intentionally absent (Meta-only).
- **`src/components/AttendanceDayDetail.tsx`** — one person's attendance on one day, with every correction a manager can make. **The single detail view**, behind both the Attendance List's pencil and the calendar's squares; the write operations live in `src/lib/attendanceEdits.ts` (`saveCorrection` / `addRecord` / `deleteRecord` / `loadDay`) so there is one implementation, not one per view. It fetches the day itself rather than taking a slice from the caller: the calendar keeps one record per cell, so a split shift would otherwise show half the day's hours, and after a correction the caller's copy is stale by definition. Every write still goes through `attendance_records`, still passes the geofence trigger, and is still audited into the History Log by the database.
- **`src/pages/MetaCampaigns.tsx`** — **Meta Campaigns** (Media). Read-only; Meta's own records, shown unchanged. Its own page rather than a CrudConfig because it must load a *small* default set out of 1,200 and its search has to reach the ones it deliberately did not load. Default scope = spent something in the last 90 days; "All campaigns that spent" is the archive. **A campaign that has never spent is listed nowhere and offered nowhere** — Meta reports nearly every old campaign on this account as ACTIVE or PAUSED regardless of when it last ran, so status cannot separate the live board from the archive; only spend can. Figures per campaign come from `src/lib/metaAds.ts`; brand attribution from `src/lib/metaBrands.ts`. The top of the page is `src/components/MetaSummary.tsx`: five KPI cards, then a brand card (three-way spend split + top-ten table with cost per purchase), with all methodology behind an Info modal rather than on the page. A third scope, **"Needs a brand"**, is the same universe as the archive filtered to campaigns nobody has tagged and ordered by spend — tagging is a short job in that order and a hopeless one in any other. The campaign sheet carries `src/components/CampaignBrandPicker.tsx` (admin/manager/marketing).
- **`src/pages/modules.tsx`** — home of most CrudConfigs: contentTasks, paidAds, **influencers**, repairWatches, demandList, consignments, vipCustomers, employees, companyDocs, limitedProjects. Exports the page components.
- **`src/pages/UserActivity.tsx`, `HistoryLog.tsx`** — admin audit views.

---

## 9. Edge functions (Deno, Supabase)

| Function | verify_jwt | Trigger | Purpose |
|----------|-----------|---------|---------|
| `lightspeed-oauth-callback` | false | OAuth redirect | Completes Lightspeed OAuth, stores token |
| `lightspeed-sync` | false | cron + manual | Daily stock/sales/cost import |
| `lightspeed-po-sync` | false | cron + admin/manager JWT | Mirror SUPPLIER consignments → POs (§6.1) |
| `admin-users` | true | Settings UI | Create/edit/delete users, change password/role **+ `sales_name` on `update`/`list` (2026-09-13)** |
| `meta-ads-sync` | false | cron + manual (admin/manager/marketing JWT, or `x-sync-key`) | Pulls campaigns + insights from Meta Graph v21.0 for the account in `meta_ads_config`. **Account-level `level=campaign`**, not one call per campaign — 2,400 per-campaign calls never finished inside the 150s budget. Lifetime via `date_preset=maximum&time_increment=all_days`, daily via `time_increment=1`. Token in the `META_ADS_TOKEN` secret. Values are stored as the strings Meta returned; nothing is parsed, rounded or converted. |
| `daily-briefing` | false | cron (parked) | Email daily briefing (needs `RESEND_API_KEY`) |
| `instagram-connect` | true | Settings UI | Instagram OAuth connect (Meta path, dormant) |
| `instagram-sync` | false | cron + manual | Instagram insights via Meta Graph API (dormant — token never finished) |
| `influencer-followers-sync` | false | cron (weekly, all) + admin/manager/marketing JWT ("Refresh followers", per influencer via `{influencer_id}`) | Scrapes fresh follower counts for influencers via Apify → updates `influencers.followers`/`followers_updated` + records `influencer_follower_snapshots`. Extracts the IG username from @handle / profile URL / bare handle. **Fast-return + background**: the ~45s scrape runs via `EdgeRuntime.waitUntil`, the request returns `{started:true}` immediately, and the client polls `influencers.updated_at` for completion (a synchronous hold made the browser report "Failed to send a request"). |
| `lightspeed-sales-sync` | false | cron (every 10 min) + `x-sync-key` or admin/manager JWT | Incremental sales and customers from Lightspeed's versioned endpoints, with the token lease (§6.3) |
| `lightspeed-probe` | false | none | **Disabled stub** (answers 410) left from the 2026-09-21 read-only probe. Delete it from the Supabase dashboard; the tools cannot |
| `notify-flush` | false | cron (every 30 s), `x-notify-key` from `app_config` | Delivers due `notifications` rows by Web Push, collapsing a burst of PO events into one summary |
| `notify-test` | true | Notification Settings → Send test | Pushes a test to the calling admin |
| `notify-dispatch`, `push-notify` | false / true | none | **Deprecated**, superseded by `notify-flush`; still deployed, source not in this repo |
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
| `meta-ads-daily-sync` | `30 5 * * *` | 08:30 | `meta-ads-sync` |
| `lightspeed-sales-sync` | `*/10 * * * *` | every 10 min | `lightspeed-sales-sync` (§6.3) |
| `lightspeed-reconcile` | `20 5 * * *` | 08:20 | `lightspeed_reconcile_log()` — transactions against the daily totals |
| `customer-caches-rebuild` | `30 0 * * *` | 03:30 | `refresh_sale_credits()`, `refresh_customer_caches()` — rebuilds who may see which customer |
| `occasion-reminders` | `0 3 * * *` | 06:00 | `raise_occasion_reminders()` — birthdays and anniversaries, 7 days before and on the day |
| `remind-overdue-requests` | `0 4 * * *` | 07:00 | `remind_overdue_requests()` — chases anything waiting over a day |
| `lp-generate-tasks` | `0 6 * * *` | 09:00 | `lp_generate_tasks()` — Limited Projects role tasks |
| `notify-flush` | every 30 s | — | `notify-flush` |

Jobs that call an edge function use `net.http_post` with the `x-sync-key` header (`x-notify-key` for `notify-flush`) and `timeout_milliseconds := 150000`; the others call a database function directly. **At 08:00 Kuwait the stock sync and the 10-minute sales sync start together**; the token lease (§6.3) is what makes that safe.

---

## 10a. The shared foundation (`src/shared/`)

Mirrored **byte-for-byte** between `timekeeper-online` and `watch-store-crm`.
`npm run build` runs `shared:check`, which fails if a file no longer matches
`src/shared/MANIFEST.json`; the two repos are in step when both print the same
`foundation` hash. To change a rule: edit it in one repo, `npm run shared:hash`,
copy `src/shared/` into the other.

| File | Answers | Database counterpart |
| --- | --- | --- |
| `outlets.ts` | Which outlet is this, shop or channel? | `outlets`, `resolve_outlet()`, `outlet_key()` |
| `workedHours.ts` | How many hours did this person work? | `attendance_shifts`, `attendance_day_hours` |
| `schedule.ts` | When were they expected to work, **on that date**? | `employee_schedules`, `schedule_on()` |
| `attendanceStatus.ts` | Where do they stand today? | — |
| `storeDay.ts` | When did the shop open and close? | `store_day()` |
| `workload.ts` | Over a period, who carried how much, and is it fair? | — |
| `portalRules.ts` | Kuwait dates, distance, leave balance. | — |
| `portal.ts` | What My Portal asks the database. | — |
| `live.ts` | Keeping a current-day screen up to date. | `supabase_realtime` publication |
| `punctuality.ts` | Was this day late, or did they leave early — against which shift and which grace? `DayPunctuality` carries its date. | `employee_schedules.grace_minutes`, `settings.late_grace_minutes` |
| `requestRules.ts` | What a correction is actually asking for (`planCorrection`), and whether it changes anything. | `v_requests.changes_nothing` |
| `requests.ts` | Which tab a request sits in for this reader (`tabOf()`), what may still be edited, when a reminder is allowed. | `v_requests`, `workflow_guard()`, `remind_request()` |
| `notifications.ts` | Reading the feed, unread counts, mapping a notification's link to this app's page. | `notifications`, `notification_settings.shop_floor` |
| `phoneRules.ts` | Is this a phone number, and what is its one true form (E.164, Kuwait by default)? | `normalize_phone()` |
| `caseLabels.ts` | What a stored entry type is called on screen: Browsing, Interested, Lost Opportunity, Manual Sale. | `cases.case_type` (values unchanged) |
| `messageRules.ts` | A WhatsApp template filled in, the greeting name, the `wa.me` link. | `render_template()`, `message_for()` |

`npm test` runs `src/shared/__tests__` (139 checks on 2026-09-24, no database
needed) and is part of the build. Where a rule also lives in SQL, its fixtures
were produced by running the SQL, so the two cannot drift without a test
failing.

### The four outlets

| code | display | kind | sells | attendance | geofence | opens/closes | POS name | DSR name |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `avenues` | Time Keeper - Avenues | physical | yes | yes | yes | yes | `Time Keeper - Avenues` | `Avenues` |
| `time_gallery` | Time Gallery | physical | yes | yes | yes | yes | `Time Gallery` | `TimeGallery` |
| `whatsapp` | Time Keeper WhatsApp | digital | yes | no | no | **no** | `Time Keeper`, Eman only | `WhatsApp` |
| `online` | Time Keeper Online | digital | yes | no | no | **no** | `Time Keeper`, everyone else | *(none yet)* |
| `hq` | Timekeeper HQ | physical | **no** | yes | yes | **no** | — | — |

**One till register, two channels.** The POS has three registers but the shop
sells through four channels: the register called **`Time Keeper`** carries both
the online shop and the WhatsApp orders Eman handles. Only the salesperson tells
them apart, so a till sale resolves from the register *and* who rang it up:

```
Time Keeper + Eman        → whatsapp
Time Keeper + anyone else → online     (the register's catch-all)
Time Gallery / Avenues    → themselves, whoever was serving
```

The rule is data, not code — `pos_channel_rules`, one row per case, so a second
person selling on WhatsApp is an insert rather than a deployment. Matching is a
case-insensitive substring, so `Eman` catches the till user `Eman Salman`.

`lightspeed_sales_by_staff` carries the per-salesperson daily totals the split
needs, written by `lightspeed-sync` from the same pages it already fetches (no
extra API calls). `lightspeed_sales_daily` is **unchanged** and remains the
authoritative outlet-day total; `pos_channel_sales` splits it and reconciles
back to it exactly, carrying any remainder in the register's catch-all channel
with `attributed = false`. Read `pos_channel_sales`, never the raw register
names.

Eman's own *attendance* is at HQ; her sales channel being WhatsApp must never
make WhatsApp behave like a shop.

**Never compare outlet text with `===`.** Four systems spell these four outlets
four different ways. Use `resolveOutlet` / `sameOutlet`, or `resolve_outlet()`
in SQL.

### Rules worth not rediscovering

- **An open shift is the hours so far, never zero.** Three screens reported 0.
- **A shift open more than 16 hours was never clocked out.** Its length is
  `null` — unknown, not enormous — and it shows as needing a correction. Ten such
  records existed when this was written, the oldest running since 6 August.
- **Nobody is absent just because they are not here.** Only flag a person on a
  day the schedule *in force on that date* expected them. An unknown schedule is
  `no_schedule`, never `missing`.
- **Schedules are dated.** Changing a shift next month must not re-judge last
  month. `set_schedule()` does the splitting in one transaction.
- **Realtime is for today only**, and a table delivers nothing unless it is in
  the `supabase_realtime` publication.

---

## 11. DSR (watch-store-crm) notes

- `src/utils/report.ts` — `buildDailyStats`; **follow-up conversions are separated** from the normal daily report (`followUpWins`, `followUpWinRevenue`, `dayCases`). Brand and product-type revenue are attributed **per line item** via `utils/saleItems.ts#getEffectiveItems` (same as the manager dashboard) — never read `case.brand` for money, it only names the first item. Brand Analytics PDF has **no Lost column**. The PDF paginates itself: header + footer on every page, section headings never orphaned from their table (`heading()`/`ensureSpace()`), tables carry `TABLE_MARGIN` so continuation pages clear the header. `shareReport` → `'shared'|'downloaded'|'cancelled'`.
- **Three "conversion" formulas coexist** (known, not yet unified): PDF + TodayLog = `sales ÷ (sales + lost)`; `closeDay`/`rebuildDaySummary` stored summary = `sales ÷ (sales + follow-ups + lost)` plus a visitors variant. Same day can show different percentages in the PDF and in the stored WhatsApp text.
- **Navigation (2026-09-21):** salespeople get **Home · Today · Follow-ups · Customers · Me**; managers and owners **Home · Today · Follow-ups · Customers · More**, with Team under More and a Team card on Home. Logging a visit is the big button on Home and Today, not a tab. `/` renders `SalesHome.tsx` for the floor and `Home.tsx` for managers.
- **`SalesHome.tsx`:** where you are and whether you are clocked in, what is waiting (overdue and due follow-ups, occasions this week), your day's visits by outcome, and Lightspeed's figure for you. On the shared phone it speaks for the outlet instead, with no clock and no till figure. **Switch** records a mid-day move with `log_outlet_change()` before changing the outlet, so a refusal leaves the phone where it was; the shared phone must name who is moving.
- **Customer Visit (`QuickEntry.tsx`, 2026-09-21):** the three outcomes and a smaller Manual Sale, labelled through `caseLabels.ts`. **Visit time** is set when logging late and editable afterwards (`QuickEntryEdit.tsx`); it moves `date_logged`/`time_logged` with it. As a number is typed, `customer_by_phone()` says new / yours / recognised; a new valid number becomes a `customers` row on save. A Lost Opportunity may be saved as declined, with no number. `/entry?contact=&name=` opens the form pre-filled (used from a customer's page). **Outcome button classes are written out in full** — Tailwind strips any component class whose name is assembled at runtime (§12).
- `src/components/TodayLog.tsx` — close day, PDF share; staff can pull only **yesterday's** report, admin any past day. **One `reportOutlet` drives everything on it** (2026-09-21): the list, the figures, the day-close row, the summary and the PDF, and the confirmation names the outlet being closed. The owner's outlet filter used to change only the list, so closing while filtered to one shop closed the company. Since the same day it also shows **Lightspeed today** for the outlet (not for the shared login), and after closing offers **Send summary on WhatsApp**, the Report Preview text rebuilt fresh.
- **The day report PDF** (`src/utils/report.ts`, 2026-09-21) is **100 mm wide and exactly as tall as its content**: rendered once on a very tall page to measure, then again at the height used. Headline figures three across, breakdowns stacked, each visit's customer and note under its item. A day past 1,400 mm paginates, with a header on every page.
- **Customers (`CRM.tsx`) and WhatsApp (`WhatsAppSheet.tsx`, 2026-09-21):** the list, filters and each customer's page, from `customer_list()` / `customer_profile()`. The shared phone sees none and says why. WhatsApp opens from a customer, a follow-up and an occasion; on the shared phone the sender must be named. A reminder's link `/crm?customer=…&wa=…` opens the customer with that template ready.
- **Team → Requests and the bell (2026-09-18):** `TeamRequests.tsx` gives a store manager the request queue on the device he carries; `MyRequests.tsx` lists a person's own, editable or withdrawable while Pending; `AskForSchedule.tsx` asks for different hours. The top-bar bell and `Notifications.tsx` show only shop-floor event types (§5 Notifications) and translate the back office's links to this app's pages.
- **Version (2026-09-23):** `WhatsNew.tsx` — the version and build under the title, and What's new under More.
- `src/components/Reports.tsx` — admin "report for any day + outlet" builder (`day_closes` are per-outlet).
- **Personal logins** (2026-09-13): `AuthContext` exposes `salesName` (= `employees.dsr_staff_name`, falling back to the deprecated `profiles.sales_name` mirror). When it is set: Quick Entry's Staff field is read-only and logs as that name (`lastStaff` ignored), Edit keeps the case owner and forbids reassignment, Close Day's closer defaults to it, and audit `by:` records the actor (`salesName ?? owner`). **The outlet picker stays for every staff login** — the day's report is per-outlet and people cover between the two shops, so nobody is pinned to one. `outletChosen` is derived (`role !== 'staff' || !!activeOutlet`), and `signOut` clears `activeOutlet` + `lastStaff` (now keyed `lastStaff:<uid>`) so the next login on the same phone starts clean. `db.updateCase` **throws** on error (it used to swallow it): with personal `created_by`, a colleague's edit of your same-day Sale is refused by RLS and now shows as an error toast.
- **`/portal` — My Portal, inside the DSR** (`src/components/MyPortal.tsx`, tab "Me" on mobile / "My Portal" on desktop): a salesperson's own page — clock in/out (geofenced), month attendance summary, attendance history by month, annual/sick balance, apply for leave or WFH, edit or cancel their own pending request, ask for an HR update or attendance correction, and their HR record. It reads the same tables as Timekeeper Online's `/me`; RLS already limits each to the signed-in person's own rows, so **a salesperson never has to open the other app**. Shared helpers in `src/utils/attendance.ts` (`lateClassOf`, `isEarlyLeave`, `workingDaysBetween` — Fridays never consume leave — and `haversineMeters`). Needs the HR link (`employees.user_id`) and a geofence named like `employees.location`; without the link the page says so instead of failing.
- **Today's Log header names the scope** (2026-09-13): under the date, a location chip and an account chip say which outlet's day is on screen and which login is looking at it (`Fadi Hussain · Fadi` when the roster name differs; `Staff` on the shared login). The outlet chip is hidden for admin, whose outlet dropdown sits beside it and already says `All Outlets`. Several people share one phone and the report is per-outlet, so neither fact should need a menu.
- **Follow-ups can be created and edited from their own page** (2026-09-13): a **New** button in the header opens a modal asking the same required fields Quick Entry does (brand, action, contact, callback date, notes) so both doors produce follow-ups the shop can act on; Staff is asked only on the shared login (a personal login files under its own roster name) and Outlet only when the session has not pinned one — an entry with no outlet is invisible to every per-outlet report. **Edit Details** in each row's Actions menu reuses `QuickEntryEdit`, the same editor Today's Log opens, so a case is corrected identically wherever it is reached from; it stays available after the day is closed because a follow-up outlives the day it was logged on, and the RLS UPDATE branch for open follow-ups has no `day_locked` test. Field errors clear as each field is filled.
- **Own follow-ups only, enforced in the database** (2026-09-13): the `cases` UPDATE policy used to let any floor login change *any* open follow-up with no ownership test — the restriction was the screen, not the rule. It now matches on the roster name, like the app: `get_my_sales_name() is null` (the shared shop login, deliberately unchanged — its board shows everything, so its reach must too) `or staff = get_my_sales_name() or created_by = auth.uid()`. The `with check` half drops the `status = 'Open'` test (closing one as Won/Lost writes a new status) but keeps the ownership test, so a personal login cannot hand a follow-up to a colleague. Migration `20260913200000_own_follow_ups_only.sql`; helper `get_my_sales_name()` mirrors `get_my_role()`.
- **Follow-ups are scoped to the person** (2026-09-13): with `salesName` set, `FollowUps.tsx` derives everything from one `scoped` memo (`followUps.filter(c => c.staff === salesName)`) — KPI tiles, overdue/due-today, brand and product-type counts, the filters, Analytics, Group-by-brand and the list — and the staff filter dropdown is hidden. Matched on the **roster name, not `created_by`**, so rows logged under the shared login before the person had their own account still reach them. A manager (no `salesName`) sees the whole board, unchanged. **Today's Log and the day's PDF stay whole-outlet** on purpose: whoever sends the report has to be able to check the day first.
- **Day closes are per-outlet, and `outlet = ''` means "all outlets"** (closing from the owner's "All outlets" view writes `''` and locks every shop's entries) — `getDayClose(date, outlet)` matches `outlet in (outlet, '')` and prefers the exact row, so a blank-outlet close covers every shop that has not closed its own day. That is right for a finished day and catastrophic for a live one: it locks both shops' logs with no way to switch out of it. The auto-close safety net writes blank rows, so it may **only ever run on a day that is over** — `utils/dayClose.ts#dayIsOver` guards every call, and `App.tsx` polls every 10 min for the *previous* day rather than aiming a `setTimeout` at midnight (a sleeping phone defers that timer, and it decided which day to close when it fired).
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
- **Meta figures are never computed.** Spend, impressions, reach, clicks, CTR, CPC, CPM and Results are shown as the strings Meta returned — not rounded, not converted, not re-derived. CTR/CPC/CPM are *Meta's own fields*, never spend÷impressions arithmetic. Meta bills this account in **USD**. Since 2026-09-16 spend is **displayed** in KD at `meta_ads_config.kwd_per_usd`, a fixed rate an owner sets in Settings → Ad spend currency — a display conversion only: the stored strings are never touched, only USD is converted (`inDisplayCurrency` refuses any other account currency, so moving the account to KD cannot triple every figure), every converted number prints the rate beside it, and the **campaign sheet still shows Meta's own USD figures verbatim** because that is what somebody checks against Ads Manager. A null rate falls back to showing Meta's currency rather than inventing one. Impressions, clicks, CTR, CPC, CPM and Results are never converted — only money is. The only numbers the app produces itself are the page totals and the brand rollups, which are **sums** of Meta's per-campaign figures and are labelled as ours. **Reach is never totalled** — Meta counts it as people, once per campaign, so a sum double-counts by an unknowable factor. **Ratios are never averaged** — the mean of per-campaign CTRs is not the account's CTR.
- **A brand set on a campaign always beats its name.** `attribute()` in `src/lib/metaBrands.ts` reads `meta_campaign_brands` first and only falls back to the name-reader; never reverse that order, and never write a tag from a script — "set by hand" is the page's one signal that a human confirmed it, and a seeded row would claim a check nobody made. A campaign tagged with several brands is counted under **Several brands**, not under each: Meta reports one figure for the campaign, so adding it to both would make the bars exceed the spend and splitting it evenly would invent a number.
- **The name-reader is the fallback only** (`brandOf()`), and it is a best-effort read, not a link. Meta does not know our brands. Three traps live in the real data: **"YOKO" in `CPN - YOKO x Time Keeper …` is the agency, not a brand** (and it is the largest campaign on the account, so a naive extractor puts the agency top of every chart); the `brands` table contains **"Timekeeper"**, which substring-matches every campaign name; and most campaigns are boosted Instagram posts whose Meta name is the post caption, **truncated mid-word by Meta**, often before the brand appears. Anything not confidently identified is `Unknown`; campaigns that were never for one brand (retargeting, catalogue, app, straps, seasonal sales) are `Whole shop` — a separate answer from `Unknown`, and on this account the larger one.

- **The service worker serves the network first for pages** (both apps, 2026-09-21). A navigation waits `SHELL_TIMEOUT_MS` (3.5 s) for the server and falls back to the cached shell only when offline or stalled; install fails unless every essential file fetched OK; a 404 on a hashed asset empties the stale cache and posts `stale-shell` so the page starts again. `index.html` carries an inline boot failsafe: if React has not set `window.__booted`, it reloads once (`tk:recovering` / `dsr:recovering` in sessionStorage) and then shows a Reload panel instead of white. `scripts/sw-check.mjs` (11 checks) runs in the build. Cache-first navigation is what served iPhone Safari a shell pointing at assets a deploy had deleted — the white page; Chrome on iOS does not run service workers, which is why switching browser appeared to fix it.
- **Never assemble a Tailwind class name at runtime.** Tailwind reads the source as text and emits a class only if it finds that exact name, and that applies to classes defined in `@layer components` too. `` `type-btn-${cls}` `` shipped with no styles at all, so three of the four DSR outcome buttons never showed a selected state. Write every name out in full, in a lookup if need be.
- **Both apps are served from one origin** (`alalramadhan-kuwait.github.io`), so they share `localStorage` and `sessionStorage`. Prefix every key with `tk:` or `dsr:`, or one app's value silences the other's.
- **`CREATE OR REPLACE FUNCTION` with a new parameter creates an overload, not a replacement** — see §5 *Notifications* for how that stopped clock-ins.
- **Judge a Kuwait day with `kuwait_today()` / `kuwait_day_of()`**, never `current_date`; the database runs in UTC.

### 12.1 A better way to link a campaign to a brand

Reading brands out of campaign names identifies about a quarter of the spend on this
account, and it cannot do much better: Meta names a boosted post after the post's own
caption and truncates it, frequently before the brand appears. Three options, in the
order they are worth doing.

1. **Store the brand, one campaign at a time** (recommended). A `meta_campaign_brands`
   table — `campaign_id` primary key, `brand_id` referencing `brands`, plus a "not for
   one brand" marker and who set it — and a brand picker on the Meta Campaigns detail
   sheet for admin/manager/marketing. Whatever is stored wins; the name-reader stays as
   the default for anything unset, so the page keeps working from day one and gets more
   accurate every time somebody opens a campaign. Roughly 60 campaigns carry 90% of the
   spend, so an afternoon of tagging would take attribution past 95% permanently. It also
   fixes the cases no naming convention ever could — a campaign for two brands, or a
   caption that never mentions one.
2. **A naming convention, applied going forward.** The `CPN - … | OBJ - … | LD - …`
   campaigns already carry structure; adding a `BR - <brand>` field would make new
   campaigns self-describing. This costs nothing to read but only ever fixes campaigns
   created after the agency adopts it, does nothing for the 357 already there, and cannot
   work at all for boosted posts, where the name is not ours to choose.
3. **Meta's own campaign labels.** Ads Manager supports labels on campaigns, returned by
   the API. Same benefit as (2) without touching names, but it depends on the agency
   maintaining them and still cannot be applied retrospectively without the same manual
   pass as (1).

Do not attempt to infer a brand from the linked `paid_ads` row's free-text fields, and do
not extend the alias list into guesswork. A brand's spend is a number somebody will act
on; `Unknown` is the correct answer when the data does not carry one.

---

## 13. Changelog

- **2026-09-24** — **A clock-in counts once.** Eman's clock-in went through twice, ten seconds apart (two open records, closed 14 s apart at 16:18), and every total added them: My Portal showed 12h 55m at about 3:55 pm for a day begun at 9:27, and `attendance_day_hours` held 13.69 h for a 6.85 h day. A new BEFORE INSERT trigger `attendance_one_open_shift` refuses a clock-in while the same person has an open shift younger than `attendance_abandon_hours()` (older open shifts were never clocked out and do not block), under a per-person advisory lock so simultaneous taps queue; both portals reload after a refusal so the page shows the shift that is already open. `dayHours()` (shared) and the `attendance_day_hours` view now count overlapping time once; across all 173 recorded days only that one day changed. My Portal (both apps) and the shop app's Home clock card now take today's total from `dayHours()` instead of their own sum. The duplicate record itself was left in place. Migration `20260924140835`.
- **2026-09-23** — **Both apps carry a real version.** The shop app said 1.2.14 for ten days and 69 changes; the back office said 0.1.0 from June onward and showed no version at all. Each app now keeps plain-language notes in `src/releases.json` beside `package.json`'s version, and `scripts/release-check.mjs` (mirrored, run by `npm run build`) fails the build unless the newest notes are for that version, well-formed, newest first. Tapping the version line opens What's new (`src/components/WhatsNew.tsx`), with a dot until this device has opened the notes for the running version — `localStorage` `dsr:whatsNewSeen` / `tk:whatsNewSeen`, prefixed because both apps are served from one origin. The back office gained the `__BUILD_SHA__` build stamp the shop app already had. CI tags `vX.Y.Z` at the deployed commit the first time a version ships (GitHub refs API; 422 means already tagged; any other failure warns and never fails the deploy). Starting points: **shop app 2.0.0, back office 1.0.0.** Routine: CLAUDE.md → Releases.

- **2026-09-21** (later 4) — **The day report belongs to one shop, and reads on a phone.** On the owner's screen the outlet filter changed the list and nothing else: the Close Day preview counted every outlet, and `closeDay` was called with an empty outlet — which locks every shop's entries and files one combined report. Filtered to Avenues (8 sales, 2,338 KD) the preview showed the company (13, 3,302) and closed it. One `reportOutlet` now drives the list, the figures, the close row, the summary and the PDF, and the confirmation names what is being closed (§11). Closing offers the Report Preview on WhatsApp. The PDF moved from A4 to a 100 mm page cut to the height of its content. Also: three of the four DSR outcome buttons had never shown a selected state, because their Tailwind class names were assembled at runtime and stripped from the build (§12).

- **2026-09-21** (later 3) — **Customers and follow-ups on the shop floor (Stage C).** Built on Stages A and B; the full rules are in `supabase/README.md` → *The customer and the follow-up*.

  *Customer Visit* replaces Quick Entry. The stored `case_type` values are unchanged; what people read is Browsing, Interested, Lost Opportunity and Manual Sale (`src/shared/caseLabels.ts`). The visit has its own time, correctable afterwards. As a number is typed, `customer_by_phone()` says new, yours (with a line of history) or only "recognised" when the customer is somebody else's — the shared phone only ever hears "recognised". A Lost Opportunity may be saved with the number declined rather than invented.

  *Home and navigation.* Salespeople open on their own day (`SalesHome.tsx`); both roles get five tabs with Customers among them; logging a visit is the big button, not a tab. A mid-day move between shops is recorded against the open shift (`outlet_changes`); the shared phone names who is moving, using `roster_employees()` because it may not read `employees`.

  *Customers* in both apps come from `customer_list()` / `customer_profile()`, which run under the caller's rules. *WhatsApp* opens from a customer, a follow-up or an occasion with an admin-edited template in English or Arabic, filled in and editable; the handoff is recorded, never marks a follow-up contacted, and is refused without a relationship. *Occasions*: birthdays, anniversaries and other dated occasions, 59 birthdays imported from Lightspeed; at 06:00 Kuwait `raise_occasion_reminders()` sends one person a reminder seven days before and on the day.

  *Afterwards*, the security advisor showed the anonymous role could still call the new definer functions through Postgres's default grant to PUBLIC. Revoked from `anon` and `PUBLIC`, granted to signed-in users; the reminder job is the cron's alone (migrations `20260921143217`, `20260921143826`).

- **2026-09-21** (later 2) — **Who may see whom (Stage B).** Until now any signed-in login could read every entry and every customer's number. Access now follows a *relationship* between a salesperson and a customer — an entry under their roster name, a Lightspeed sale credited to them, a manager's assignment, a WhatsApp handoff — held in `customer_relationships` and rebuilt by triggers and nightly, so a corrected entry takes its access away with it. Managers see their `manager_scopes` outlets and channels through the registry. The apps read entries through `cases_visible`, which blanks numbers the reader may not see. Customer identity is guarded in the database: normalised on the way in, a duplicate or non-number refused, a number Lightspeed holds corrected at the till, every change audited. Policies call set-returning definer helpers inside `(select …)` so they evaluate once per query — the first version evaluated per row and timed out. `customers_from_lightspeed()` created 8,713 customer records. Verified as each real login in turn; the rules, and the shared-login limitation, are in `supabase/README.md` → *Who may see whom* and §4.

- **2026-09-21** (later) — **Every sale kept, and who the customer is (Stage A).** The daily sync read every sale and kept only totals. `lightspeed-sales-sync` now stores every sale, line and customer every ten minutes (§6.3): the first run caught up 18,047 sales back to November 2021 and 14,330 customers. The token refresh is leased so the three Lightspeed jobs cannot lock each other out. `lightspeed_users` maps till logins to employees or channels by id, not name — three of seven salespeople are spelt differently in Lightspeed. `normalize_phone()` and `src/shared/phoneRules.ts` define a phone number once. `cases` gained `customer_id`, `interaction_at` and `contact_declined`, backfilled (125 customers from numbers already logged, 151 entries linked). `lightspeed_reconcile()` compares the new rows with the old totals: 137 of 137 days and 277 of 277 salesperson-days agreed to the fils. Invisible to users; nothing existing changed.

- **2026-09-21** — **The app stopped going white on iPhone Safari.** Safari's service worker answered every navigation from cache and never checked again, while each deploy deletes the previous build's hashed files; a phone holding an older shell asked for JavaScript that no longer existed and drew nothing. Install also cached error responses and did not wait for its writes. Staff were told to use Chrome, which worked only because Chrome on iOS runs no service worker. Now network-first with a 3.5 s deadline, strict install, self-recovery on a 404, and a boot failsafe in `index.html`; `sw-check` runs in the build. Both apps. See §12.

- **2026-09-20** — **Watch Design Studio tables.** `watch_designs`, `watch_design_versions`, `watch_design_assets` and the `watch-assets` storage bucket were added to this database by the studio, which lives in its own repository (§5). Own-rows policies throughout. Their migrations are not in either of these repos' folders.

- **2026-09-19** (later) — **An outlet-scoped alert with no outlet belongs to nobody.** `audience_outlet` was a day old, so every older notification carried null, and null meant company-wide: a shop's manager was still shown head office's requests. `notification_settings.outlet_scoped` now marks the types that must carry an outlet, and for those a missing one reaches no manager (`notification_in_my_scope()`). Ten of fourteen untagged rows were recovered from the request each points at; the rule stops the other four. Admins and HR are unaffected.

- **2026-09-19** — **The shop floor's bell carries only what a store manager can act on.** He was addressed by fifteen of twenty-six event types, and four fifths of what reached him was purchase orders, account changes and geofence edits he cannot act on from a shop. `notification_settings.shop_floor` now marks the types that belong on a phone; the back office still shows everything. On the real feed, 101 notifications become 21. `repair_status` and `preorder_arrived` are deliberately left off: their tables carry no outlet, so there is no way yet to send them to the right shop.

- **2026-09-18** (later 5) — **Clocking in broke, and why.** Adding an outlet parameter to `notify_event` with `CREATE OR REPLACE` created a second, nine-argument function beside the old one instead of replacing it. Because the new parameter had a default, every existing eight-argument call matched both, Postgres refused to guess, and every trigger calling it failed — including the one on clock-in. Fixed by keeping one signature (§5 *Notifications*).

- **2026-09-18** (later 4) — **Lateness is findable, and grace belongs to the shift.** HR → Attendance gained This month / Last 30 days / Last month, a heading that says it holds hours late and early, and a name that opens into the days behind its totals (`DayPunctuality` now carries its date). Employee Performance counted lateness from the stored `is_late` flag while HR asked the shared engine, so one person could read "3 late" on one page and "–" on the other; both now ask the engine. The company's hour of grace was written for a 09:00 start and moved a 10:00 shift's deadline to 11:00; `employee_schedules.grace_minutes` now lets a shift carry its own (null = company default, 0 = the start is the deadline). Head office's schedules had been set from when people actually arrived — typically 10:00 — which, with the grace hour, forgave everything until 11:00; all five are now on 09:00 with the ordinary hour.

- **2026-09-18** (later 3) — **Reminders, scoped alerts, and asking for different hours.** Request notifications went to every manager regardless of shop; they now carry `audience_outlet` and the read policy narrows managers to their scopes (completed the next day, above). **Remind** sends one nudge to whoever holds a request up, refuses another inside four hours and records it in `request_reminders`; `remind_overdue_requests()` chases anything over a day at 07:00. Employees can edit or withdraw their own request while it is Pending (DSR `MyRequests.tsx`). **Schedule change** became a request type, applied through `set_schedule()` on approval. Found by testing a real one: staging was skipped when there was no auth context, which the view read as "no manager needed"; staging now happens on every insert whoever makes it.

- **2026-09-18** (later 2) — **One approval workflow for every request, and the shop floor is told.** `leave_records` had a proper manager-then-owner chain; `employee_requests` had one status column, no manager stage, no scoping, and a policy letting any manager hard-delete any request. Both now share one spine, one guard (`workflow_guard()`) and one answer to "who is this waiting on" (`v_requests.stage_owner`). A request filed by an admin or HR on somebody's behalf no longer skips the manager — the reason fourteen of fifteen leave records read "Not required". The owner can still settle something a manager has not, but only with a written reason, recorded as an override against the stage it skipped. Nothing is hard-deleted. The Inbox became one queue with three tabs (§8); the DSR gained Team → Requests and its first notification centre, since the store manager's approval authority had existed only on a laptop. New events `req_stage` and `req_withdrawn` announce the silent middle of a two-step approval. `audit_log.actor_kind` separates system writes from people. The store manager's name, spelt three ways across his login, employee record and 492 entries, was made one.

- **2026-09-18** (later) — **Routine SQL stops asking for permission; destruction still does.** `.claude/settings.json` in both repos pre-approves reads and non-destructive migrations; a PreToolUse hook asks before a DROP, a TRUNCATE or a DELETE with no WHERE. CLAUDE.md records the working agreement: one migration per feature, one approval request for the whole of anything destructive, and the migration file in both repos under the version the database recorded.

- **2026-09-18** — **Hours vary, the shops have hours, and the shifts nobody closed are closed.** A schedule that sets no hours now means *hours vary* — nothing is claimed about lateness — instead of falling through to the office's 09:00–17:00, which had scored an afternoon salesperson nineteen hours late across three days he arrived on time. `outlets.opens_at` / `closes_at` give the shops the one time true for everyone on the floor. Twelve shifts were still open, the oldest since 6 August (1,021 hours), because the app had refused clock-outs without a GPS fix; each was closed at the latest time that person could still have been there, marked in `correction_reason` and `geo_flag` so all twelve list and revert with one query, with notifications off for the transaction. The migration folder was also brought back in line with the database: four applied migrations had no file, and six files carried invented timestamps that would have replayed them out of order.

- **2026-09-17** (later 8) — **A clock-out no longer needs a location, and a correction asks the right question.** A clock-out has never needed a fix — there is no geofence test on leaving — but the app refused to write one without it, so shifts could not be closed. A clock-out with no fix is now recorded and flagged `no_clock_out_location`. The correction form pre-filled the arrival and left the leaving time empty, then sent the arrival anyway; its boxes now start empty with the record shown beside them, and `planCorrection` in `src/shared/requestRules.ts` decides what is being asked, so a request that changes nothing cannot be sent. Approval no longer re-applies an unchanged time (which would have shaved its seconds) and recomputes lateness only when the arrival moves. Overnight shifts are no longer rejected as leaving before arriving. The shared-foundation check had not been hashing `__tests__/`; it now covers them.

- **2026-09-17** (later 7) — **An attendance correction reads as a change.** Each half of the day is a row — what the record says, what is asked for, an arrow only where something would change — so a missing clock-in can be told from one being moved, and a request asking for what is already recorded says outright that approving it changes nothing.

- **2026-09-17** (later 6) — **Lateness is judged against the hours somebody actually works.** Punctuality was measured against a hardcoded 09:00–17:00 for everybody. It now comes from the dated schedule in force on the date, falling back to a shop-wide default only for somebody with no hours set; that default became settings (`work_start_time`, `work_end_time`, `late_grace_minutes`). A day judged against the default says so ("default hrs"); a day nobody clocked out of has no leaving time to judge. HR → Attendance gained hours late and hours early.

- **2026-09-17** (later 5) — **The Time Keeper register is two channels, not one.** It carries both the online shop and the WhatsApp orders Eman handles, and the only thing telling them apart is who rang the sale up — which the sync was fetching from Lightspeed and throwing away. It now keeps it (`lightspeed_sales_by_staff`, same API calls), and `pos_channel_sales` splits the register by `pos_channel_rules`: Eman's sales are WhatsApp, everyone else's are Online. `lightspeed_sales_daily` is untouched and stays the figure everything reconciles to. The dashboard reads channels and no longer sees a register name, and the one Time Keeper monthly target became `sales_target_online` + `sales_target_whatsapp` (the old figure moved to Online, where three quarters of the money is; WhatsApp starts blank rather than inheriting a guess).

- **2026-09-17** (later 4) — **One foundation under both apps.** Before redesigning anything, the two apps were made to agree on what they were looking at. `src/shared/` (§10a) is mirrored byte-for-byte between them, with a counterpart in the database for reports and exports, and the build fails if the copies drift.

  *Outlets* got a registry. The same four outlets were spelled four ways across `cases`, `employees`, `geofences` and the till, and every join between sales, staffing and revenue went through an ad-hoc normaliser written slightly differently each time. Nothing was renamed: `resolve_outlet()` and `resolveOutlet` map every historical spelling to one of five codes. The two shops are separated from the two digital channels — Online and WhatsApp sell but have no attendance, no geofence and no opening time — and the office sells nothing but has both. The till's `Time Keeper` register turned out to be the WhatsApp channel's takings, and the dashboard now says so instead of showing a fourth shop.

  *Worked hours* had six implementations. Three reported an open shift as **0 hours**, so somebody on the floor since nine had worked nothing at four in the afternoon. Worse, counting an open shift up to now would have credited one person with a thousand hours: ten shifts were still open, the oldest since 6 August. A shift open past 16 hours is now **unknown** (`null`), flagged as needing a correction, and left out of every total.

  *Attendance status* was decided separately on every screen, so a person could read as present on one and absent on another. One engine, one vocabulary. Nobody is absent merely for not being here — only for a day the schedule *in force on that date* expected them, and an unknown schedule says so rather than accusing anybody.

  *Schedules* became dated (`employee_schedules`, `set_schedule()`), so moving somebody to afternoons next month no longer turns last month's on-time mornings into late arrivals — and are editable from **HR → Employees → Schedule**, which previously meant writing SQL.

  *The roster name* stopped being stored twice. `employees.dsr_staff_name` is the source of truth; `profiles.sales_name` is a trigger-kept mirror. Having two and syncing neither is what locked a salesperson out of the DSR.

  *My Portal's rules* — clocking in and out, leave, the balance, corrections, geofence matching — moved to `src/shared/portal.ts`, used by both screens. The shop floor had never recorded how accurate the phone's fix was on clock-out, so half of them could not be checked against the geofence afterwards.

  *storeDay* kept a shop open by checking the date was today, which mislabelled an overnight shift and let a clock-in nobody ever closed hold the shop open indefinitely. Abandoned records are excluded by age instead.

  *Team's* own status words are gone in favour of the shared ones, so "in now" and "not in" mean the same on both apps, and its hours-per-person loop is now `shared/workload.ts` — the same count HR reports with. A genuinely lopsided week is called out, compared as hours per day due so a part-timer is measured against their own roster.

  *Realtime* was switched on for the first time. No table was in the `supabase_realtime` publication, so the DSR's Today's Log and follow-up board had been subscribed for months and receiving nothing. Five operational tables now publish; historical reports do not.

- **2026-09-17** (later 3) — **The DSR opens on the shop for a manager.** The bottom bar carried 4 tabs for a salesperson, 6 for a manager and **8** for an owner, and the app opened on Quick Entry — so a manager's first sight each morning was a form for logging a customer. Managers and owners now get five: **Home · Entry · Team · Follow-ups · More**; salespeople keep their four. `/` renders the right page for the role, so the old once-per-sign-in redirect to `/manager` is gone.

  *Home* — shop open/closed with who opened it and who is on the floor; a Needs-attention block that only appears when something is; today's takings, sales, lost, interactions and month-to-date against the outlet's target; team standings; the manager's own clock-in; one **New Entry** button. Not a dashboard — the month and the brand charts stay in `ManagerDashboard`, one tap away under More.

  *Store open/close comes from attendance*, not a button somebody would forget: first clock-in opens the shop, it stays open while anyone is still clocked in, last one out closes it. `StoreDayDetail` is the same component for today, yesterday and any past day, with ← date → and Today.

  *Team* is today plus the week's hours, so an unfair split is visible; tapping somebody opens `AttendanceSheet`, the Dashboard's own month calendar, now exported rather than rebuilt.

  **Schema:** migration `20260917120000` adds `employees.expected_days` (dow array, default Sat–Thu), `shift_start`, `shift_end`. Nothing knew when anybody was due — the attendance calendar inferred a working day from *anyone else* clocking in, which marks a person absent on their day off whenever a colleague works. Nobody is now flagged missing before their start time has passed, or on a day they were not due. **Editing these is not in the HR form yet** — the default covers every current employee.

  **`src/utils/outlet.ts` (DSR) matters beyond this page:** the same shop is spelled four ways — `cases.outlet` says `TimeGallery`, `attendance_records.location` and `employees.location` say `Time Gallery` — and a store page is exactly that join. Matched on a normalised key rather than renamed, since the strings sit in hundreds of case rows, in `settings.outlets` and in each session's chosen outlet.

  New: `utils/storeDay.ts` (pure — store state, standings, `shiftHours`), `db/storeToday.ts` (one round trip per outlet-day), `components/Home.tsx`, `Team.tsx`, `StoreDayDetail.tsx`, `More.tsx`. Untouched and shared: QuickEntry, TodayLog, ManagerDashboard, the follow-up rule, the attendance queries. Verified by 29 checks on the pure logic and 30 driving the screens at 320/390 px.

- **2026-09-17** (later 2) — **A blocked-location refusal now says what to do about it.** The stores manager could not clock in; the screen said *"Location is blocked. Allow location for this site in your browser settings"* while his status bar read **◀ WhatsApp**. A page opened from a link inside WhatsApp runs in WhatsApp's own browser and inherits **WhatsApp's** location permission, which is usually off — so the single instruction the app gave him was the one that could not work, and on an iPhone "your browser settings" covers three screens anyway. This was `GeolocationPositionError.code === 1`; the geofence never ran.

  `locationHelp.ts` (both apps, kept in step) writes the refusal for the device holding it: iPhone leads with the in-app-browser case, then Safari's per-site Location, then Location Services; Android gets the padlock; a *named* in-app browser (Instagram / Facebook / Line, which identify themselves in the user agent) is told outright. WhatsApp on iOS does not identify itself, so it is described rather than detected.

  Two things beyond wording. The refusal now shows **before** the button is tapped when the Permissions API reports `denied` — somebody standing in the shop at nine should not discover this by failing. And every version ends with the way out: ask for a correction, which since earlier today carries the times and applies them on approval.

  Verified across four user agents (iPhone Safari, Android Chrome, an Instagram in-app browser, desktop): each gets its own advice, the numbered steps survive as separate lines, the correction fallback is always offered, and nothing overflows 390 px.

- **2026-09-17** (later) — **The attendance calendar's week reads like a date, and its arrows stay on one line.** The header said `2026-09-12 → 2026-09-18`: eight digits twice to work out that it is one week in September. `rangeLabel()` (`src/lib/dateRange.ts`) says the shared parts once — `12–18 Sep 2026` within a month, `28 Sep – 4 Oct 2026` across two, `28 Dec 2026 – 3 Jan 2027` across two years. Display only: `anchor`, `days` and every query still use the same yyyy-mm-dd strings, which is why the formatter takes those strings and never builds a `Date` — no parsing, so no timezone to get wrong.

  The controls were one wrapping row of five things, so on a phone the **→ arrow fell onto a second line, away from its ←**. They are two rows now: Month/Week with **This week** beside it as a secondary action, then `←  label  →` on a row that cannot wrap — no `flex-wrap`, `shrink-0` on both arrows, and a label that truncates rather than pushing an arrow off the end. Arrows gained aria-labels.

  Verified: 9 ranges against the spec as a unit test (both boundaries, a whole month, a year end), and the layout driven at 320 / 390 / 768 / 1280 px — the three controls share a row, in order, with the next arrow on screen and no horizontal overflow at any width.

- **2026-09-17** — **The attendance calendar's squares open the day.** A red square was the one thing a manager wanted to click and the only thing that did nothing: corrections lived in the List view as an inline row welded to that table's state, so the calendar beside it could show an unexplained absence and offer no way to fix it.

  Rather than build a second editor, the existing one was **extracted once and used twice**. `src/lib/attendanceEdits.ts` holds the three writes — correct, add, delete — that were previously closures inside the List; `src/components/AttendanceDayDetail.tsx` is the panel; the List's pencil and the calendar's squares both open it. Nothing was duplicated and no new path to the data was created: the same table, the same geofence trigger, the same History Log audit.

  Two things changed for the better on the way. The panel is **per day, not per record**, so a split shift shows both halves and the day's real total — the List's editor showed one row at a time, and the calendar's cell map keeps only the first record per day, so both were quietly wrong about a two-shift day. And a day with **no** record opens too: leave, a day off and an unexplained absence each say why they look that way, and an absence offers to add the missing record there and then.

  Squares that cannot have a record — a future day, or somebody with no linked login — stay unclickable rather than opening an empty panel. Every square carries a readable label for screen readers and a focus ring for keyboards.

  A correction made in the modal repaints the square behind it: the detail reloads itself, then tells the calendar, which refetches the range, which recolours the cell and updates the unexplained-absence count. It tells the page too, so the List is not stale when somebody toggles back.

  **No SQL was needed.** The three writes already existed and were already permitted by `managers_write`; only their callers changed. Verified with 23 checks in a browser — 12 on the panel (both shifts of a split day, the day's total, lateness recomputed from a corrected arrival, a manager-added record carrying the employee and shop, a delete writing its reason before the row goes) and 11 on the calendar (squares are labelled buttons, future days and account-less people disabled, the right person and day opening, a correction repainting amber to green, and a red square explaining itself and offering the fix).

- **2026-09-16** (later 5) — **Clock in at whichever workplace you are standing in.** Asked why the stores manager, who runs both shops, could not clock in at either. He can: **nothing has ever read `employees.location` when deciding a clock-in** — that field routes leave approvals and files reports, and the HR form's single Location dropdown makes it look like a restriction it is not. Both apps, and the `attendance_enforce_geofence` trigger, match on position alone. (Colleagues clock in at Avenues at 8–15 m and Time Gallery at 51 m, so both fences work.) Two real faults found on the way:

  *The gate tested the nearest fence rather than the one you are inside.* `attendance_enforce_geofence` took the closest active geofence and measured you against **that one's** radius. Where sites are far apart the two questions have the same answer, which is why it has never shown: Time Gallery and head office are 295 m apart with 120 m radii. Widen either, or add a fourth site near an existing one, and standing inside B while marginally nearer to A is refused with a message about A. The app has always looped over every fence and matched any one you are inside; the database disagreed with it. Migration `20260916210000` makes it ask the same question, for clock-out too — off site now means outside **every** fence, so a manager finishing at the other shop is no longer flagged as having left work.

  *The Avenues geofence was called "Avenue".* The trigger writes the matched fence's name onto the record, so five clock-ins were filed at a workplace matching nothing, while the four people who work there are filed at "Avenues" — in the column used to join attendance to the roster. Renamed and the five rows backfilled.

  Both portals' refusal message now names **every** workplace with its distance instead of only the nearest, because "you are 340m from Avenues" reads as "this account is tied to Avenues".

  **Not fixed, worth knowing:** a refused clock-in raises an exception and leaves no row, so nothing in the data can answer "why could he not clock in" after the fact. Hussain has no attendance records at all and no trace of an attempt.

- **2026-09-16** (later 4) — **An attendance correction says which day and which times, and approving it fixes the record.**

  The old path: My Portal → "Ask for a correction" → one free-text box → `employee_requests` → the approver's Inbox → Approve. Approve set `status = 'Approved'` **and nothing else**. To actually change the record the manager then opened HR → Attendance, found the day, and retyped the times out of the employee's paragraph. Three failures in one: the employee could describe a problem without ever being asked for a time, so half the requests did not contain the answer; the manager retyped from prose, which is where 17:30 becomes 17:00; and "Approved" meant a manager agreed, not that anything changed — an approved correction and an applied one looked identical, so one could be agreed to and quietly never made.

  Both portals (DSR and Timekeeper) now ask for **the day, the arrival time, the leaving time and the reason**. Any past day — a missed clock-out is usually noticed when the month's hours are read, not on the day. The form shows what that day currently records and prefills from it, so one end is changed rather than both retyped; **an empty box means "keep what is recorded"**, which is a real answer and is said on screen. A day with no record at all is askable, and is called out as such.

  Migration `20260916190000` adds `attendance_date`, `proposed_clock_in`, `proposed_clock_out`, `attendance_record_id`, `applied_at` and `applied_by` to `employee_requests`, with two checks: a correction naming a day must propose at least one time, and the times must fall near that day (an overnight shift is fine, a time three months away is a typo). `details` is still written as a readable sentence, because that is what notifications and older screens show.

  The Inbox shows the times as times — "Tue 15 Sep · Arrived 08:55 · Left 17:30", or "unchanged" for an end being kept — and **Approve applies it** (`src/lib/attendanceCorrection.ts`). A time nobody gave is left alone; lateness is recomputed from the corrected arrival unless the day was already excused; a day with no record gets one created, carrying the employee's shop; a leaving time with no record and no arrival is refused rather than a start being invented; and a record deleted since the request becomes an insert rather than a failure. If the write fails, the status is not changed — a request reading Approved over an unchanged record is worse than one plainly stuck. `applied_at` records that the approval actually reached the record.

  Verified: 8 checks against the live schema (both constraints, an overnight shift, an HR update unaffected, an approver recording `applied_at`, nothing left behind) and 15 against the apply logic in a browser, covering every branch above.

- **2026-09-16** (later 3) — **Ad spend reads in KD.** Meta bills this ad account in USD and reported every figure in USD, so the one number an owner wants to hold against a budget was the only number on the screen in a foreign currency — the Paid Ads Tracker literally had a KD budget column beside a USD spend column, with a comment saying they were not comparable. Both are KD now.

  The rate is typed in, not fetched: **Settings → Ad spend currency** (owner only) writes `meta_ads_config.kwd_per_usd`, seeded at 0.3065. The dinar is pegged and moves by fractions of a per cent in a year, so a daily sync would add something that can fail in exchange for noise — and a rate fetched today would still be applied to spend from 2023.

  It is a **display** conversion and nothing more. The stored strings are untouched; `inDisplayCurrency()` converts only when the account currency is USD, so moving the account to KD one day cannot silently triple every figure; a null rate falls back to Meta's own currency rather than to zero; every converted figure carries the rate beside it; and the **campaign sheet still shows Meta's USD figures verbatim**, with the KD as a second line under spend, because that sheet is what somebody checks against Ads Manager. Only money converts — impressions, clicks, CTR, CPC, CPM and Results are Meta's and are not currency.

  Verified: 11 checks in a browser — the total, brand spend and cost per purchase all in KD at the right arithmetic, the rate stated under the dashboard, and the campaign sheet still carrying Meta's `1294.98` and `1.656968` unchanged beside its KD line.

- **2026-09-16** (later 2) — **The Meta Campaigns page reads as a dashboard.** Five figures across the top — spend, impressions, clicks, purchases, spending campaigns — then one brand card: the three-way split of the spend as a bar, and a compact table of the top ten brands by spend with share, purchases and **cost per purchase** (ours, not Meta's, and only where there is something to divide by). The reasoning that used to sit in front of the numbers now sits behind an **Info** button: what is deliberately not totalled and why, how purchases are counted, and how brands are attributed. The rules are unchanged — reach is still never summed, ratios still never averaged, there is still no combined "Results" — they are simply not read aloud on every visit. The "worth naming next" queue is gone from the dashboard; tagging lives on the **Needs a brand** tab, which is what it is for. The page's own blurb and the list's caption were cut to one line each. On a phone the brand bars drop out so the numbers fit without scrolling sideways.

- **2026-09-16** (later) — **The brand a campaign was for is now something somebody says, not something a regex guesses.**

  Reading brands out of Meta campaign names topped out at a quarter of the spend, and it could not have done much better: most campaigns on this account are boosted Instagram posts whose Meta name is the post's own caption, truncated mid-word and often before the brand appears. `meta_campaign_brands` (migration `20260916140000`) stores the answer instead, and a stored answer always wins — the name-reader is only what happens until somebody has been there, which is why the page worked on day one with the table empty.

  *Four answers, and the fourth earns its place.* A campaign can be for **one brand**, for **several** if it genuinely covered several, for the **whole shop** (retargeting, the catalogue, the app, straps, a seasonal sale), or **unknown**. "Unknown" is selectable on purpose: without it somebody picks a brand they are not sure of to make the screen stop asking, and a guess stored as fact is worse than no answer — it is a figure somebody acts on. "Whole shop" and "Unknown" stay separate answers because on this account they are $88k and $25k respectively, and folding them together would blame the naming for money that was never meant to belong to a brand.

  *A campaign with two brands is counted under "Several brands", not under both.* Meta reports one spend figure for the campaign. Adding it in full to each brand would make the bars add up to more than the spend; splitting it evenly would invent a number nobody knows. The brands are named on the row and in the campaign's sheet, so nothing is lost — it is simply not claimed to be divisible.

  *Where to start.* A third scope, **"Needs a brand"**, lists the untagged campaigns biggest spender first, and the brand card carries a short queue of the same with the running share ("naming just these 5 covers 99% of it"). On this account roughly sixty campaigns carry ninety per cent of the money, so the order is the whole job. The card also now says what share of the spend has a brand **set by hand** versus read from a name, because the two are not equally good and the page should not imply they are.

  *Integrity, in the database rather than the screen.* Two partial unique indexes (one row per brand per campaign; at most one "no brand" marker) plus a trigger refusing a campaign that holds both brands and a marker. The picker writes a whole decision at a time and would not produce that combination, but this is money reporting, so it is refused rather than trusted. Writes are open to the same admin/manager/marketing who can see the figures — unlike the figures themselves, which are Meta's and nobody edits.

  Verified: five database guards exercised directly (two brands allowed; marker-beside-brands, brand-beside-marker, the same brand twice, and a `kind`/`brand_id` mismatch all refused, each with the message a person would see) and 14 checks driving the real picker in a browser — a marker saved and re-read, an Arabic post whose name says Unknown overridden to West End, a two-brand campaign landing in "Several brands" without being double-counted, coverage moving off 0%, and a tag cleared back to name-reading and staying cleared through a re-read.

- **2026-09-16** — **Paid ads read their figures from Meta, and the campaigns page says where the money goes.**

  *The figures.* The Paid Ads Tracker had always been typed in by hand — an ad name, a budget, a status — while what a campaign actually did lived only in Ads Manager. A nightly `meta-ads-sync` now pulls campaigns and insights from the Meta Graph API for ad account `140760819`, and **every figure is stored and shown as the exact string Meta sent**: TEXT columns, no rounding, no currency conversion, and CTR/CPC/CPM taken from Meta's own fields rather than worked out from spend and impressions. Meta's currency (USD) is labelled as Meta's; the tracker's budget stays KD; the two are never mixed. A tracker row is pointed at a campaign through a searchable picker that stores Meta's campaign **id**, and the page opens on the last good figures with a "Last successful sync" pill even when a sync has failed. Two things were learned the expensive way: 2,400 per-campaign insight calls cannot finish inside an edge function's 150s, so the sync asks the *account* for `level=campaign` in one request; and `effective_status` is useless on this account for telling a live campaign from a dead one — Meta reports all 1,200 as ACTIVE or PAUSED however long ago they last ran. **Spend is the only usable signal**, so a campaign that has never spent is kept in the database and offered nowhere. The one exception is a campaign already linked to a tracker row: excluding it from the picker would have written `null` over a link somebody made on purpose, which was caught by reading the save payload rather than the screen.

  *Meta Campaigns (new page, under Media).* Read-only, separate from the tracker and labelled as such on both. Default view is the campaigns that spent something in the last 90 days; the archive and the search reach every campaign that has ever spent.

  *What the top of that page shows, and what it deliberately does not.* The data was studied before anything was designed. On this account: **357 campaigns, $149,947.88 lifetime, Aug 2023 – Sep 2026, 54.4M impressions, 1.45M clicks, 2,067 purchases** from 103 of the 357. Four figures are shown — spend, impressions, clicks, purchases — and they are sums of Meta's own numbers for the campaigns currently listed, so they always add up to the rows underneath, search included. **Reach is not totalled**: Meta counts it as people, once per campaign, and a sum double-counts by a factor nobody can estimate. **CTR, CPC and CPM are not averaged**: the mean of per-campaign ratios is not the account's ratio, and re-deriving them from the totals would mean computing a Meta metric ourselves. **There is no combined "Results" card**: six objectives run here (`OUTCOME_SALES` $112k, `LINK_CLICKS` $19k, `OUTCOME_APP_PROMOTION` $10k, `OUTCOME_TRAFFIC` $6k, `MESSAGES` $2k, `OUTCOME_ENGAGEMENT` $270), and adding purchases to app installs to link clicks gives a number that means nothing. Purchases is shown alone because it is one thing throughout. The page says all of this in a collapsed note rather than leaving it to be guessed at.

  *Brands.* Meta does not know our brands, so the only link is whatever was typed into a campaign name, and reading them has a hard ceiling here: **a brand is identified for about a quarter of the spend**. Three traps in the real data. `CPN - YOKO x Time Keeper …` is the largest campaign on the account at $28,520 and **YOKO is the agency, not a brand** — a naive extractor puts the agency top of every chart. The `brands` table (42 rows) contains **"Timekeeper"**, which substring-matches every campaign name. And 290 of the 357 campaigns are boosted Instagram posts whose Meta name is the post's own caption, **truncated mid-word**: `…هذا إصدار خاص للكويت من دبليو ام…` is cut two letters before the brand. So there are three answers rather than two — a brand, **Whole shop** (retargeting, the catalogue, the app, straps, seasonal sales: campaigns that were never for one brand, and $88k of the $150k), or **Unknown**. Collapsing the last two would blame the naming for money that was never meant to belong to a brand. Arabic transliterations already on the account are matched as aliases (وست اند / ويست إند = West End, دينسون = Dennison, يونيماتيك = Unimatic, دفو = Dvo), taken from the campaigns themselves rather than invented. The section leads with a stacked bar of the whole spend — the honest headline is that most of it is not for one brand — and lists the named brands underneath on their own scale, because against a full-width scale every brand collapses to a sliver at exactly the place someone is trying to compare them. Top brand by spend: **West End**; top by purchases: **WMT Watches**. Verified: the classifier run against 27 real campaign names, Arabic and truncated ones included, all as expected; totals cross-checked against SQL over all 357.

  *Known limit, and the fix.* Name-reading is a stopgap. The proper answer is a brand chosen once per campaign and stored — see §12.1.
- **2026-09-16** (early) — **A clock-in now has to be proved, not promised.** Someone clocked in at a shop he was not standing in, and nothing in the system could have stopped him: the geofence test lived entirely in the browser (`MyPortal.clockIn` read the fences, measured the distance and simply chose not to insert when too far), while the database accepted whatever arrived. The `own_all` policy lets a signed-in person write their own attendance row, so a clock-in from anywhere went through if the insert skipped the page — an old tab, a hand-made request, coordinates typed in by hand, or no coordinates at all. A row reading "Timekeeper HQ" only ever meant *the phone said so*. Migration `20260916140000` moves the check into a `before insert or update` trigger (`attendance_geofence_gate`) where it cannot be stepped around: a self clock-in **must** carry coordinates, the server re-measures them against the active geofences with its own `geo_distance_m()`, anything outside every radius is **refused**, and **the matched fence names the site** — the phone no longer gets to say where its owner was standing. A fix the device admits is vague (a wifi/cell guess wider than `settings.geo_max_accuracy_m`, default 200 m) is refused too, since inside a 200 m circle it proves nothing; a cached older app that reports no accuracy at all is kept and flagged `no_accuracy` until every phone has been reopened and the admin ticks **Refuse phones that report no accuracy** (`geo_require_accuracy`) — a locked-out shop floor at 9am would be worse than a flagged row. Staff may no longer edit a stored clock-in (time, coordinates, site, lateness) — only close it. Clock-out is measured and flagged `offsite_clock_out` but **never refused**: nobody may be trapped on the clock. Each row now carries `clock_in_distance_m` / `clock_in_accuracy_m` (written by the database, never the client), `geo_source` (`device` / `manager`, so a hand-entered row is never mistaken for a verified one) and `geo_flag`, including `repeat_fix` — coordinates identical to an earlier clock-in to the last decimal, which a live GPS fix never is, and which the existing data already shows. Attendance shows the metres next to the site ("Timekeeper HQ · 39 m"), because the radii are wide by necessity and a site name alone never showed whether someone was at the counter or in the car park. My Portal now watches for up to 10s and keeps the sharpest fix instead of taking the first cached guess, and sends its accuracy. Settings gained an **editable radius** per location (it previously took a delete-and-re-add) — the radius is the strictness dial: HQ 200 m, Time Gallery 250 m and Avenues 300 m all take in the street and the parking, which is the *other* half of this incident.


- **2026-09-14** (later 6) — **Both apps are installed applications now, and the DSR keeps what you were typing.** The same work across `timekeeper-online` and `watch-store-crm`.

  *Shared shape.* Each app declares a manifest (`display: standalone`, `orientation: portrait`, `id`/`start_url`/`scope` `./`), a full-bleed icon with a separate **maskable** variant, an `apple-touch-icon`, a Home Screen name (`Timekeeper` / `DSR`) and **24 iOS launch screens** covering every iPhone and iPad Apple still ships, portrait and — on iPad — landscape, in the app's own background colour so nothing flashes on open. Both refuse the browser's own zoom: `maximum-scale=1, user-scalable=no` in the viewport, the `gesturestart/change/end` events refused in script (Safari ignores the tag), `touch-action: manipulation` for double tap, and every keyboard-bearing field at 16px on a coarse pointer. The trackpad pinch is refused **only on touch devices** — zooming a page of figures at a desk is reasonable. The four safe-area insets are named once as `--sa-t/r/b/l` custom properties, which also makes a notched layout testable by setting them.

  *Service worker (both).* `public/sw.js` precaches the shell; the hashed asset list and a build id derived from it are written in at build time by a Vite plugin (`serviceWorkerManifest` in each `vite.config.ts`), so the file differs exactly when the output differs — the only signal a browser uses to notice a new worker. **Cross-origin requests are never touched**: every figure comes from Supabase, and a cached sales number is not a faster answer but a wrong one. Opening after install is ~60–85 ms against 2.2 s (Timekeeper) / 3.2 s (DSR) on 4G and 21 s / 30 s on slow 3G. The DSR's worker keeps its Web Push handlers unchanged; what it lost is the `skipWaiting()` it used to call on install — **a new version now waits and the app offers it**, and taking it reloads, so an update can no longer replace the app under someone mid-form.

  *Timekeeper Online.* Safe areas extended from three ad-hoc places to the whole shell — mobile header, sidebar and its footer, page body, record sheet, sign-in screen. The record editor (`CrudModule`'s `RecordForm`) now keeps a **draft** as you type and offers it back with a Discard when you reopen the same record within two hours; drafts are per user and cleared on sign-out (`src/lib/drafts.ts`). The app also reopens on the page you left, for eight hours, unless a link or a notification says otherwise (`src/lib/platform.ts`).

  *DSR.* Two real bugs fixed on the way. The bottom navigation carried a class **`safe-area-bottom` that was never defined anywhere** — not in the stylesheet, not in the Tailwind config — so on every iPhone with a home indicator the Entry/Today/Follow-ups buttons sat underneath it; the class exists now, along with `safe-area-top`/`safe-area-x` on both fixed bars, and `<main>`'s top padding grows with the status-bar inset. And `theme-color` was `#0a0a0a` above a white header, which Android drew as a black band; it matches the bar now. **Josefin Sans is self-hosted** (latin subset, `public/fonts/`) instead of fetched from `fonts.googleapis.com` — that request blocked the first paint on a third party and meant the app could not open offline with its own branding. **Quick Entry keeps a draft** of the entry in progress (`src/lib/drafts.ts`, 12-hour life, per user, cleared on save and on sign-out): until Save a sale exists nowhere but that phone, and a phone locks between customers. Coming back within the same visit restores silently; a reopened app says so and offers Discard.

  *Dashboard, Timekeeper Online.* The headline **Sales this month** tile now lists the three shops beneath the total — each one's takings and how far through **its own** target it is, in the same order as the bar chart. The figures were already computed for that chart, so this adds no query. On a phone the tile takes the full row; in the two-column grid the shop names truncated to "Ti…".

  Verified: 26 + 26 assertions on the installed behaviour of the two apps, 18 + 18 on the workers, offline, route memory and the update path, and 13 + 9 on the two draft stores. Both typecheck and build clean.


- **2026-09-15** — **The first leave approval follows the manager, and head office has one.** Routing asked *"is this person based at a shop?"*, which gave the shops a first approver and left head office without one: HQ leave was stamped `Not required` the moment it was created and went straight to the owners. Head office does have a manager (Eman Salman, Operations Coordinator), so a step that was meant to exist never ran — and because the record read "not required" rather than "pending", nothing on screen showed it had been skipped. Found when an owner asked how to tell whether Eman had approved Ali Akbar Modi's sick leave: she had not, and had never been asked. Routing now asks **who approves for this person's workplace**, held in a new `manager_scopes` table (migration `20260915090000`). A manager covers a **set** of locations rather than the one they are filed under — this matters immediately, because the shops manager sits at Time Gallery and also runs Avenues, so routing by the manager's own location would have quietly cut the three Avenues staff loose. The seed reproduces exactly the routing in force the day before and adds head office, so nobody's chain changed by surprise: Eman → Timekeeper HQ (3 staff), Hussain → Avenues + Time Gallery (4). `is_store_manager()` is superseded by `can_give_first_approval()` and `my_approval_locations()` and kept only so a client already loaded in a browser keeps working. **The Inbox now shows a manager only the people they cover** — it filtered on `manager_status` alone, which was right with one manager and would have put head office's requests in front of the shops manager, and the shops' in front of head office, the moment there were two. Pending requests that gained an approver were moved from `Not required` to `Pending` rather than left looking deliberately waived. Nobody signs off their own leave: a manager who is the only approver for their own workplace still has no first step. Verified by impersonation in the live database — Eman may give the first approval on a HQ request but not on her own and not the final one; Hussain is refused on a HQ request ("Only this employee's manager can give the first approval"); the test's write was rolled back to Pending.

- **2026-09-14** (later 4) — **More than one shift a day.** Fadi works a morning and an evening; clocking out ended the day in both portals — the button became a "Done" badge with no way back in. The table never had a per-day constraint, so every wrong assumption was in the apps. Both My Portals now hold **all** of today's records (`todayRecs`), derive `openRec` / `firstRec` / `lastRec` from the list, and always offer Clock In again ("Clock In Again", with the hours so far beside it). **Lateness belongs to the clock-in that opened the day** — an evening shift is no longer written as late (`is_late` is only set when `todayRecs.length === 0`) and the label reads off `firstRec`. Per-day aggregation replaced per-record in four places: days present (`byDay.size`, not row count), missing hours (a day's total against the 8-hour standard, not each half), late days (the first record of each day), and the manager's card and calendar. A calendar square now sums the whole day, carries a dot per shift, and lists each shift in its tooltip; the card says "3 shifts" when a day was split. Today's strip reads **First in / Last out / Total**. Asking for an attendance correction no longer requires having finished the day. Verified by driving a real in-out-in-out day in a browser (two records, only the first late, one day present) and a split day through the manager dashboard (2 days, 3 shifts, 16h, one late).

- **2026-09-14** (later 3) — **The manager's dashboard is month-by-month, with hours and an attendance calendar.** The Today/History toggle is gone — Today's Log already covers the live day — leaving one view navigated a month at a time (the current month is labelled "so far"). Each team card now carries the same month's attendance beside the sales: hours over days worked, lates, days on leave, and a note when a shift was never clocked out, so the hours read as understated rather than wrong. **Attendance** on a card opens that person's month as a calendar — one square per day (worked with hours, late, leave, Friday, absent; future days blank, never "absent") over a list of every clock-in with in/out times. New `db` helpers `getTeamDirectory` / `getTeamAttendance` / `getTeamLeave`; a manager may already read every attendance row (RLS `managers_read`). Joining sales to HR needed a link that did not exist — `cases.staff` is a short roster name, `attendance_records.employee_name` the full legal one, and `profiles.sales_name` only covers people with a login (three of five salespeople have none) — so **`employees.dsr_staff_name`** now carries it on the HR record (migration `20260914140000`, seeded for all six roster names). Clock times are pinned to `Asia/Kuwait`, not the viewer's device: rendering the sheet from a UTC machine showed an 08:55 start as 05:55, which is what an owner checking from abroad would have seen.

- **2026-09-14** (later 2) — **The Dashboard is the store manager's main page, and it is built around his people.** He lands on `/manager` instead of Quick Entry (once per sign-in, in `AppShell`, not as a route rule — tapping Entry afterwards still works; owners keep their Quick Entry habit). The compact staff leaderboard became **one card per salesperson**, shared by the Today and History views via `buildTeam(cases)` + `<TeamCards>`: revenue headline with a share-of-team bar, then sales, close rate, average sale, lost, browsing headcount, open follow-ups with an overdue count, and their best-selling brand. Tapping a card filters today's list to that person, or drills into their cases over the range. **Close rate is `sales ÷ (sales + lost)`** — the daily PDF's formula, so the manager and the report agree; the old leaderboard divided by every case, counting browsing visits as chances lost. Nobody with no decided sale gets a 0% verdict — they show "—". One more fix on the way in: the sidebar edit granting him the Dashboard had silently not applied, so the same account showed six tabs on a phone and four on a laptop.

- **2026-09-14** (later) — **The store manager works the floor too.** Hussain Dib's login was created as role `manager`; a check of the data showed 476 cases logged as "Hussein Deeb", the latest two days earlier — he sells as well as manages. `manager` was not a floor role in the DSR and could not insert a case or close a day, so he would have met no outlet picker, both shops mixed in one list, and a refusal on his first sale — the same trap `sales` hit the day before. `manager` now joins `staff` and `sales` in `isFloorRole` and in the `cases` INSERT / `day_closes` INSERT policies (migration `20260914120000`). He is deliberately left **without** a `sales_name`: that field drives attribution *and* follow-up scoping, and a manager's board must show the whole shop. Verified with his real account: he can log a sale, close a day, and give the first leave approval (stamped to him, with the owner's final approval stamped separately).

- **2026-09-14** — **Store manager: two-step leave approval and the numbers.** Hussain Dib runs both shops (HR job title "TK Avenuse & TG Manager"); the software had no store-manager concept at all — `manager` was company-wide, could not log or close a day in the DSR, was never asked for an outlet, and had no dashboard. Now: **leave is signed off twice** — anyone based at a shop needs the store manager first, then the owners; head office and the manager's own leave go straight to the owners; an owner may decide first and the manager's step is recorded as Skipped; a manager's rejection ends the request there. Routing is by `employees.location` against a new `store_locations` table (a third shop is an INSERT). `approval_status` keeps its meaning as the final answer — balances, alerts and the dashboard all read it — and the manager's step lives in `manager_status`. A trigger enforces the chain, not the UI (migration `20260914080000`). Inbox shows the store manager only his half and writes the right column; Leave Tracking gains a "1st approval" column; both My Portals say which desk a pending request is on. The store manager also gets the DSR **Dashboard and Reports** (`canSeePerformance`), covering stores, staff and product/brand signals, plus Timekeeper's Employee Performance which his role already allowed — CRM, Settings and closed-day edits stay with the owners. Found and fixed on the way: **cancelling a leave request had never worked** in either app (both send `Cancelled`; the check constraint did not list it, so every cancel failed).

- **2026-09-13** (later 8) — **Salespeople can now add and correct their own follow-ups.** Two of the four gaps listed when the owner asked what the Follow-ups page cannot do. **New** opens a create modal on the page itself (no detour through Quick Entry), mirroring Quick Entry's required fields and defaulting the callback to tomorrow; a personal login is never asked who it is for, and the outlet is asked only when the session has not pinned one. **Edit Details** joins each row's Actions menu and opens `QuickEntryEdit` — the editor Today's Log already uses — so the customer, contact, model and notes can be fixed on any day, not only the day it was logged. Deliberately **not** granted: deleting a follow-up, and handing one to a colleague (that would undo the restriction tightened an hour earlier). Verified in a browser for both logins: 19 checks on the personal path (validation blocks an empty save, the payload carries the roster name, the session outlet, `Follow-up`/`Open` and a created-by audit entry; the editor opens prefilled with the staff field read-only and saves the changed contact without moving the owner) and 4 on the shared login (Staff and Outlet are asked and required). One defect found and fixed while looking at the screenshot: filled fields kept showing their red error until the next submit.

- **2026-09-13** (later 7) — **A salesperson can now only change their own follow-ups.** The board had been scoped to the person that morning, but the `cases` UPDATE policy still admitted any open follow-up to any floor login, so the limit was cosmetic. Tightened to match the UI (see §11), with the shared shop login left alone on purpose. Verified against the live rows by impersonating each login inside a rolled-back transaction: Fadi updates his own 12 and none of the other 10; he can close his own as Won; handing one to a colleague is refused outright (`new row violates row-level security policy`); the shared login still reaches all 22 across four salespeople. No app change — `FollowUps.handleAction` already toasts the error and reloads. Confirmed in production minutes later: Fadi's own login marked `20260820-004` contacted and bumped its callback to 20 Sep.

- **2026-09-13** (later 6) — **The auto-close closed a day that was still trading.** Reported as "I change the outlet and it still shows closed". Both shops showed `Closed at 12:29` all afternoon with the log padlocked and no Close Day button, and switching outlet changed nothing. Cause: `App.tsx` aimed a `setTimeout` at midnight and recomputed *which day to close* when it fired — an iOS tab that sleeps defers a pending timer, so on the shop's shared phone it fired at 12:29 and closed **13 Sep** (server `created_at` confirms 09:29:09Z, with the correct yesterday-close following 12 s later from the same session). Because auto-close passes no outlet, the blank row covered both shops (see §11). The same shape is visible on 5 and 7 Sep. Fixed: new `utils/dayClose.ts` (`localDay`, `previousDay`, `dayIsOver`), auto-close now polls every 10 min for the previous day and refuses any date that is not over, and it reads *that day's* cases (`getCasesByDate`) instead of today's to decide whether the day had trade. Separately, `TodayLog.load` was a `useCallback(…, [])`, so the per-outlet close row was fetched once at mount and an outlet switch kept the old shop's banner — now keyed on `[onFloor, activeOutlet]`. Data repair: deleted the bogus `day_closes` row for 13 Sep (no case was actually `day_locked`, so nothing else needed undoing). Verified: the date guard against the real 12:29 timings, and a browser check that switching outlet moves between "Closed at …" and "Day Open".

- **2026-09-13** (later 5) — **Role `sales` can actually sell; Today's Log says where and who.** Fadi's account was set to role `sales` in Team Access — the obvious word — and the app keyed everything on the literal `'staff'`: the `cases` INSERT policy refused his saves, and the outlet gate skipped him, so he was never asked for an outlet, saw both shops' entries mixed in one list, and any entry he did make would have carried `outlet = null` (invisible to every per-outlet report). Fixed on both sides: migration `20260913180000_sales_role_can_log_cases.sql` admits `sales` to `cases` INSERT/UPDATE and `day_closes` INSERT alongside `staff`, and the DSR now asks `useAuth().onFloor` (`isFloorRole`) instead of `role === 'staff'` in the outlet gate, the Quick Entry chip and Today's Log's three outlet scopes. Today's Log also gained the header the owner asked for: an outlet chip and an account chip under the date (hidden outlet chip for admin, who has the dropdown). Verified at 390 px for all three logins.

- **2026-09-13** (later 4) — **Follow-ups show only your own customers.** A personal login (`salesName` set) now sees just the follow-ups it is chasing; a manager still sees the whole board. `FollowUps.tsx` derives every counter, filter, chart and row from one `scoped` memo instead of the raw list, and hides the staff dropdown when there is nothing to choose between. Scoping is by roster name, not `created_by`, so the rows a salesperson logged under the shared account before they had their own login still belong to them. Superseded the line below: **Follow-ups are no longer whole-outlet, Today's Log and the PDF still are** — the report is per-outlet and the person sending it has to be able to check it.

- **2026-09-13** (later 3) — **My Portal moved into the DSR; one app per salesperson.** A salesperson now opens only the DSR: new `/portal` route + nav tab with attendance (clock in/out, month summary, history), leave (balance, apply, edit, cancel), requests and their HR record, reading the same tables as Timekeeper Online's `/me`. New `src/utils/attendance.ts` holds the shared rules. **Reverted yesterday's outlet auto-select** (and deleted `utils/outlet.ts` + `AuthContext.homeLocation`): the picker is shown at every staff login again, because the end-of-day PDF is per-outlet and staff cover for each other. Today's Log and Follow-ups keep showing the whole outlet, unchanged — the person sharing the report has to be able to check it first. One fix found while rendering the new page: an attendance row flagged late but recomputing as on-time (possible after `work_start_time` changes) showed an amber dot reading "On time"; it now reads "Late".

- **2026-09-13** (later 2) — **Personal logins for salespeople (Fadi first).** Until now every salesperson used the shared `staff@time-keeper.com` login (2006 cases) and picked their name from a dropdown. Added `profiles.sales_name` (migration `20260913120000_profiles_sales_name.sql`, the first SQL file in git) + partial unique index; `admin-users` `update`/`list` carry it (validated against `settings.staff_roster`); Team Access gets a **DSR name** select and column (amber warning when set on a non-`staff` role); `Layout.canAccessPath` treats `page_access = []` as **portal only** (was: same as null) and Team Access labels it "Portal only"; Inbox identity includes `sales_name`. DSR: `AuthContext` loads `sales_name` + linked `employees.location`; Staff field locked to the DSR name, outlet pre-selected from the HR location (switchable), closer/audit use the actor, `lastStaff` keyed per login, sign-out clears outlet/last-staff, `outletChosen` derived, app waits for the profile before rendering, `updateCase` throws on error and callers toast. Geofence **Time Gallery** added (29.364062, 47.967188, 250 m; from the store's Plus Code). Fadi: login `fadi`, role staff, DSR name `Fadi`, access portal-only, HR record linked. Old "Fadi" cases keep `created_by` = shared login on purpose (analytics key on the name).

- **2026-09-13** (later) — **Deploys moved to CI in both repos.** `npm run deploy` built whatever was on the machine running it and replaced `gh-pages` with that — so a checkout that was behind `main` silently reverted the live site (it happened on 2026-09-11: the white-screen fix was overwritten for several minutes). Now `.github/workflows/ci.yml` typechecks and builds on every push to `main` and, only if that passes, publishes `dist` to `gh-pages` via `peaceiris/actions-gh-pages` with `force_orphan`. Pages settings unchanged (still branch-served). `npm run deploy` now prints why it is disabled and exits 1; the DSR's `predeploy` version bump is gone. The DSR shows `v{version} · {short sha}` (`__BUILD_SHA__` defined in `vite.config.ts` from `GITHUB_SHA`; empty in local dev) so a fresh build is visible on the phone without a version bump.

- **2026-09-13** — **Daily report PDF: layout and brand-attribution fixes** (`src/utils/report.ts`). Rendered the real generator against synthetic quiet/typical/busy days and found: (1) section headings drawn with plain `doc.text` were not paginated, so on a typical day "All Cases" sat alone 17mm from the page foot with its table on the next page, and on a busy day "Follow-up Conversions" did the same; (2) header bar only on page 1, footer only on the last page — continuation pages carried no date; (3) Brand Analytics read `case.brand`, crediting a whole multi-item basket to its first item's brand — a Rolex + Hirsch + Wolf sale showed as Rolex only, and the dashboard (which already used `getEffectiveItems`) disagreed with the PDF for the same day; (4) notes truncated at 35 chars mid-word with no ellipsis. Fixed: page geometry constants + `heading()`/`ensureSpace()` keep every heading with ≥ one table row; header + footer (with "Page n of N") drawn on every page in a final pass; tables carry `TABLE_MARGIN` so continuation pages start below the header; brand and new product-type breakdowns attributed per item via `utils/saleItems.ts` (moved out of `db/` so the PDF builder stays free of the Supabase client; `db/index.ts` re-exports it); All Cases shows "Brand +N more" for baskets, is sorted by time, wraps notes clipped at ~2 lines (full text stays in the app), and **omits browsing visits that carry no note** (they are footfall — already in the visitor count and traffic chart — and printed as rows of dashes); staff sorted by revenue; "Generated" stamp in Asia/Kuwait time. **Kept short on purpose**: KPIs in one row, tighter table rows, slim "continued" header strip on later pages. `FUTURE_IMPROVEMENTS.md` items 1 and 5 marked built (item 1 had been built already but was still listed as not started). **`.env.production` added** (public URL + anon key, same as timekeeper-online) so a deploy from a fresh clone can't ship a config-less bundle — the repo had no env file at all.

- **2026-09-11** — **Fixed blank live site.** A deploy from a checkout without `.env` shipped a bundle with an empty `VITE_SUPABASE_URL` (“supabaseUrl is required” → white screen). Rebuilt with env + redeployed (incl. the newly-added `/studio/` Watch Design Studio from another checkout). Committed the **public** Supabase URL+anon key as `.env.production` (+ `.env.example`) so every build embeds them and can't ship a config-less bundle again.

- **2026-09-10** (later 2) — **Phase 0 (structured-coding hardening).** Added Supabase scaffolding (`supabase/config.toml`, `migrations/`, `README.md` runbook) so the DB is pullable into git (`supabase db pull`; 85 migrations verified recoverable). Committed active edge functions (`notify-flush`, `notify-test`); `push-notify`/`notify-dispatch` marked deprecated. **Rotated + externalized** the notify dispatch secret into a service-role-only `app_config` table (flush cron + function read it live; verified new key 200 / old key 403). Added **ESLint (flat) + Prettier + GitHub Actions CI** (`tsc` + build are hard gates, lint informational). `.env` remains untracked.

- **2026-09-10** (later) — LP automation 4th rule: **Operations must set the expected delivery date.** A project marked **Confirmed** with no `expected_delivery` (and not yet delivered) → Operations task `lp_expdate:{id}` "Set expected delivery date — {project}" (instant on status→Confirmed via `trg_lp_tasks`, plus daily backstop in `lp_generate_tasks`); auto-closes when the date is set, delivery arrives, or status leaves Confirmed. Closes the gap where overdue tracking couldn't run without an expected date.

- **2026-09-10** — **Limited Projects → task automation.** `assigned_tasks` gained `assignee_role` (team target), `auto_key` (unique-while-open dedupe), `source_table`/`source_id`; RLS `tasks_role_read`/`tasks_role_update` let a targeted role see/progress its tasks. Automations: (1) **delivery overdue** (`expected_delivery` past, not delivered, status Upcoming/Confirmed) → Operations task "Delivery overdue" (priority escalates >3 days); (2) **delivery confirmed** (`delivered_date` set or status→Received) → Manager task "Set launch date"; (3) **launch ≤7 days** → Manager task "Confirm readiness (online + store prep)". DB trigger `trg_lp_tasks` handles instant events + **auto-close** when resolved; daily `pg_cron` `lp_generate_tasks` (06:00 UTC) handles the time-based checks, escalation, and backstop closing. `trg_task_notify` now targets a role (audience = the role) and deep-links role tasks to the source project. Inbox `myTasks` includes role-team tasks (opens the project); Assign Tasks page shows team/role, aging (open Nd), overdue, and a project link. Dashboard **"Pending tasks — N open · X overdue"** card (managers) → /tasks. Note: overdue detection needs an expected-delivery date on the project.

- **2026-09-09** (later 3) — apple-design **"bigger fluid"**: added the **`motion`** library (v13) for real, interruptible, velocity-carrying springs. The record-editor `Modal` sheet is rebuilt on Motion — enters bottom on a spring (pop on desktop), and on mobile the header drag hands its **release velocity to the spring** (§5), **projects momentum** to choose dismiss vs snap-home (§6), **rubber-bands** upward (§9), and is fully **interruptible** (§3). Notification feed items now spring in with a small stagger. All motion respects `useReducedMotion` (instant/cross-fade fallback). Replaces the earlier CSS/pointer sheet. Bundle grows ~200KB (‑gzip ~60KB).

- **2026-09-09** (later 2) — apple-design pass 2: **translucent glass mobile toolbar** (§12 — `tk-glass bg-slate-900/75 backdrop-blur-lg backdrop-saturate-150`, content scrolls under; solidifies under `prefers-reduced-transparency`), and a **route cross-fade** (§7/§14 — content keyed by pathname does a 240ms rise+fade on navigation, disabled under reduced-motion). Sidebar kept solid (structural region, per §12).

- **2026-09-09** (later) — Installed the **apple-design** skill (`~/.claude/skills/apple-design`) and applied a first pass: (1) `index.css` — instant press feedback (buttons/`[role=button]` scale 0.97 on `:active`, ease-out; §1 Response), tighter tracking on h1/h2 (§15), and `prefers-reduced-motion` / `prefers-reduced-transparency` fallbacks (§14). (2) The record-editor `Modal` (`components/ui.tsx`) is now an Apple-style sheet: enters from the bottom (pop on desktop), and on mobile the header can be **grabbed and thrown down to dismiss** — 1:1 pointer tracking with `setPointerCapture`, velocity projection (§6), rubber-band when dragged up (§9), snap-home vs dismiss by projected distance/velocity, interruptible (cancels the entrance animation and tracks from the live value, §3); a grabber handle shows on mobile. Reduced-motion falls back to a cross-fade.

- **2026-09-09** — **Admin check-in/out notifications.** `trg_attendance_notify()` on `attendance_records` fires **admin-only** pushes: INSERT → `att_in` "{name} checked in · {time}[ · late]"; UPDATE (clock_out null→set) → `att_out` "{name} checked out · {time}" (Kuwait time; deep-links to /attendance). Registered in `notification_settings` (category Attendance) so admin can toggle them off. Feed shows a clock icon for `att_*`. Note: high-frequency — one per clock-in and clock-out; respects quiet hours.

- **2026-09-08** (later 3) — **Install-as-app button** in the mobile top bar (next to the bell). `src/lib/pwaInstall.ts` captures the browser `beforeinstallprompt` (Android/desktop Chrome/Edge) so tapping the ⬇ icon fires the native install prompt; on iOS Safari (no such API) it opens an "Add to Home Screen" instructions popover. Hidden once the app is already installed (`display-mode: standalone`). Registered early via a side-effect import in `main.tsx`.

- **2026-09-08** (later 2) — `notify-flush`: the bulk PO summary now **lists brands for small batches** — ≤5 POs with ≤6 distinct brands → "3 POs updated · WMT, Rapport London, Gaga Laboratorio" (looks up each PO's brand by the notification's `record_id`); larger batches keep the "N POs updated (counts)" form.

- **2026-09-08** (later) — Dashboard: **"Who's at work now"** panel (managers/HR — gated by `can('/attendance')`), above HR & Attendance. Self-contained `WhoAtWork` component lists staff currently clocked in (today's `attendance_records` with `clock_out is null`), showing name, "since {time}", late tag, and location, with a live count and a link to Attendance.

- **2026-09-08** — PO notifications now include the **brand** in every body (new / status / shipment / payment), e.g. "PO #MAI-2185 · Rapport London → Ordered". `trg_po_notify()` builds a `· {brand}` fragment (omitted when brand is null). DB-only change; the batched "N POs updated" summary remains a count (no per-PO brand).

- **2026-09-02** (later 4) — **Managers merged into HR** (no dedicated HR role in use). Managers now have HR-level write everywhere: RLS `emp_write` (employees), `lv_write` (leave_records) and `cd_write` (company_documents) policies extended to `admin/manager/hr`; frontend `hrRoles` helper (Employees + Company Docs `canWrite`) and the Leave page `canWrite` now include `manager`. Managers can edit employee records, approve/edit leave (also unblocks the Inbox leave-approval action), and manage company documents. Attendance & employee-requests already allowed managers.

- **2026-09-02** (later 3) — **PO detail view redesigned** (summary + collapsible sections instead of a long form). New `detailView?` hook on `CrudConfig`/`CrudModule` renders a custom full record view when editing (falls back to the generic form otherwise). `PODetail` in `PurchaseOrders.tsx`: a summary header (order #, supplier · outlet, status chip, `pcs · items`, created date, plus **Balance due / awaiting-receipt** action chips), then collapsible **Order details / Quantities / Payment (open by default) / Shipment & receiving / Notes / Line items**. Lightspeed-owned reference fields (invoice #, supplier, outlet, dates, qty, status) show as compact label/value text — not input boxes; only Timekeeper-owned fields (payment, brand, project, shipment, notes, closed_override) stay editable. Cuts the mobile page height ~half.

- **2026-09-02** (later 2) — `Modal` is now a **full-screen page on every screen size** (mobile and desktop): a page-like sheet with a sticky safe-area header (Back arrow + title + close), the form content centered in a `max-w-3xl` readable column. Applies to every record editor across the app — opening a PO or any record (row tap or notification deep-link) reads as a page, not a popup.

- **2026-09-02** — **In-app Notification Center** (`/notifications`, `src/pages/Notifications.tsx`) — a per-user feed of notifications like a phone's notification list. New `notification_reads(user_id, notification_id)` table (own-row RLS) tracks per-user read state. `src/lib/notifications.ts`: `loadMyNotifications` (rows where `person_user_id=me` or `audience_roles` contains my role, minus actor & `po_summary`), `unreadNotificationCount`, `markNotificationsRead`. Feed shows icon-by-type, title, body, time-ago, and a **blue unread dot**; tapping marks it read and **deep-links to the related record/page** (reuses `?focus/?req` routing). "Mark all read" action. Nav: new **Notifications** item (all roles) with an unread **badge** (sidebar + a bell in the mobile top bar); the admin config page's nav label renamed to **Notification Settings**. Push taps also insert a `notification_read` so the feed and badge clear.

- **2026-09-01** (later 6) — Demand List: closed pre-orders/waiting-list rows no longer flagged overdue (Delivered/Converted/Cancelled show muted dates / green ✓ arrival); added a generic `rowActions` to `CrudModule` (quick per-row buttons in the actions column, writable users only) and a **"Mark delivered"** one-tap action on active pre-order rows (sets status→Delivered and reloads).

- **2026-09-01** (later 5) — **Notifications Phase 3: Admin Notification Settings** (`/notification-settings`, admin-only, `src/pages/NotificationSettings.tsx`). Config-driven now: `notification_config` (working_start/end, quiet_enabled, bulk_summary_enabled, batch_seconds) and `notification_settings` (per event_type: enabled, person_target, audience_roles, category, sort). `notify_event` consults them — skips disabled types, overrides recipients from `audience_roles` (role-based events), and computes quiet-hours/batch from config; `notify-flush` reads `bulk_summary_enabled`. Page: global **quiet hours** (toggle + start/end hour) and **bulk-sync summary** toggle; **per-type** enable switch + recipient role chips (person-targeted types show "→ employee/assignee"); **Send test** (new `notify-test` edge fn pushes to the calling admin immediately); **History** table (latest 50) with **Sent** (`delivered_at`) / **Opened** (`opened_at`) ticks. RLS: admin manages config/settings and can read all notifications. Nav: Admin → Notifications.

- **2026-09-01** (later 4) — Notifications: **opened-tracking + context banner.** Each deep link now carries `&n=<notification id>`; a global handler in `Layout` calls `mark_notification_opened(id)` RPC (sets `notifications.opened_at`) and shows a dismissible amber banner with the notification's title/body — which also satisfies "clearly indicate the related item" when the exact record can't be opened. `opened_at` column added. CrudModule no longer strips the URL param (Layout is the sole writer, avoiding a race). Sent = `delivered_at`, Opened = `opened_at` (feeds the Phase-3 history view).

- **2026-09-01** (later 3) — **Notification deep-linking + reliable tap navigation.** Every notification now stores the record id (`notifications.record_id`, parsed from the url) and a deep-link url pointing at the exact record: POs/projects/repairs/consignments/pre-orders/employees → `#/<page>?focus=<id>` (CrudModule reads `?focus` and opens that record's editor once loaded, clearing the param); inbox items → `#/inbox?focus=<id>` (row highlighted + scrolled); leave/request decisions → `#/me?req=lv-<id>` / `rq-<id>` (My Portal opens/expands that request); settings/geofence → `#/settings?geo=<id>`. Service worker `notificationclick` now `postMessage`s the hash to the focused client (reliable re-route on installed iOS PWAs, where `WindowClient.navigate` is flaky) with `navigate()`/`openWindow()` fallbacks; `main.tsx` listens and sets `location.hash`. NOTE: installed PWAs must be reopened once so the updated service worker activates before taps deep-link.

- **2026-09-01** (later) — **Management notifications, Phase 2.** Reworked delivery into a **queue + flusher** so batching and quiet hours are possible. `notifications.send_after` added; `notify_event()` now only enqueues (no direct push) and computes send time: working window **10:00–22:00 Kuwait** (outside → deferred to next 10:00), and **PO events delayed +30s** to collect a burst. New edge function **`notify-flush`** (secret-guarded) run by **pg_cron every 30s**: delivers all due rows, sends non-PO items individually, and **collapses multiple PO events into one summary** ("Lightspeed sync — N POs updated (a new · b status · c payment)"); a single PO change still sends its detailed alert. New triggers: **leave/employee_request decisions** (Approved/Rejected → the employee, opens My Portal); **repairs** Ready/Returned, **pre-orders** Arrived, **consignments** Sold/Returned/Pending payment → admin+manager; **new employee** (+hr), **new account / role change / account deleted** (profiles), **portal disabled**, **settings change**, **geofence add/update/remove** → admin+manager, open Settings/Employees. All keep Phase-1 rules (dedupe, meaningful-change-only, no self-notify). Verified: 3 PO events → 1 summary + 1 admin push in one flush.

- **2026-09-01** — **Management notifications, Phase 1 (trigger-driven).** New `notifications` table (history + dispatch queue, RLS read by audience role / owner) and `notify_event()` SQL emitter (10-min dedupe by key, inserts row, fires `net.http_post` → `notify-dispatch` edge function, secret-guarded via `x-notify-key`). `notify-dispatch` resolves recipients from the row (`audience_roles` → profiles, or `person_user_id`), excludes the actor, sends Web Push, prunes stale subs, stamps `delivered_at`. **DB triggers** (capture manual + auto/Lightspeed writes): `purchase_orders` new / status / shipment / payment-change → **admin+manager**; `limited_projects` new / status change → **admin+manager**; `leave_records` new-Pending & `employee_requests` new → **admin+manager+hr**; `assigned_tasks` new → the assignee. Actor excluded via `auth.uid()` (null for service-role syncs → notify all). App-side `notify()` calls removed (MyPortal, AssignTasks) to avoid double-send — all notifications now originate from triggers. Verified end-to-end (project insert → push delivered). Phase 2 (leave decisions, new employee, consignments/repairs/pre-orders, admin/role/settings, bulk-sync summaries, quiet hours) and Phase 3 (in-app bell + per-user mute) pending.

- **2026-08-31** (later 2) — **Collapsible sidebar sections** (`Layout.tsx`). Nav groups (Sales & Customers, Purchasing & Stock, HR & Team, Media & Marketing, Admin) now collapse; only the section containing the current route auto-opens, and the open/closed choice persists in `localStorage` (`nav-open-groups`). Top items (Dashboard/My Portal/Inbox) always show; a collapsed section with a pending Inbox item shows an amber dot. Shortens the menu, especially on mobile.

- **2026-08-31** (later) — App icon set to the supplied **tk clock monogram** (512/192/180 in `public/`). Fixed **iOS status-bar overlap** on the installed PWA: mobile top bar and sidebar header padded by `env(safe-area-inset-top)` (header also made sticky). White PWA splash, dark theme-color.

- **2026-08-31** — **Installable PWA + Web Push notifications.** App is now a PWA (`public/manifest.webmanifest`, generated clock icons `public/icon-192/512.png` + `apple-touch-icon.png` via `scripts/gen-icons.mjs`, `public/sw.js` service worker, index.html meta) — staff can Add to Home Screen and run fullscreen. Web Push: VAPID keypair stored in `push_config` (service-role only); `push_subscriptions` table (own-row RLS); `src/lib/push.ts` (`enablePush`/`pushEnabled`/`notify`, iOS-install guard); "Enable notifications" control in My Portal header; SW registered in `main.tsx` (prod only). Edge function **`push-notify`** (npm:web-push, verify_jwt) sends pushes for two events: **task_assigned** (admin/manager assigns → the assignee's account; called from AssignTasks after insert) and **approval_request** (employee submits leave/WFH/correction → all admin/manager/hr; called from MyPortal submitLeave/submitRequest). Stale subs (404/410) auto-pruned. iOS caveat: push works only when the PWA is installed to the home screen (iOS 16.4+).

- **2026-08-30** (later 2) — Scoreboard **WFH scores less than paid leave.** The `lv` CTE now splits approved absence by type: **paid leave (non-WFH: annual/sick)** adds to both `days_present` and `full_days` (full 8pts/day); **WFH** adds to `days_present` only (present ×3 + on-time ×2 = 5pts, no full-8h bonus). Legend updated.

- **2026-08-30** (later) — **Employee Performance: exclude admins + credit paid leave.** Admin-role accounts are filtered out of the page (individual selector and Overall leaderboard). `employee_scoreboard` RPC adds a `lv` CTE: approved leave working-days (Fri excluded, matching `workingDaysBetween`; leave_records joined to employees→user_id, clamped to the range) credited to the scoreboard. Legend on the leaderboard notes the rules.

- **2026-08-30** — **Fixed Employee Performance → Overall leaderboard showing nothing.** The `employee_scoreboard(since)` RPC threw `column reference "user_id" is ambiguous` (the `shift` CTE selected/grouped by a bare `user_id` that collided with the function's `user_id` OUT column), so the RPC returned null and the leaderboard rendered empty. Qualified it as `day_hours.user_id`. Database-only fix (no redeploy).

- **2026-08-25** (later 9) — My Portal month summary tiles changed from "total hours" to **Late hours** and **Missing hours**. Late hours = cumulative time arrived **past the grace window** (work_start + 1h) across the month, excluding justified records; Missing hours = cumulative shortfall **below 8h/day** on completed days (days with a clock-out; overtime does not offset). Tiles are now Days present · On time · Late hours (amber if >0) · Missing hours (rose if >0). `STANDARD_DAY_HOURS = 8`; `kwMinutes()` reads Kuwait arrival time.

- **2026-08-25** (later 8) — My Portal **Today's Attendance summary now covers the month, not the week** (per request). The three headline values (hours, days present, on-time days) are computed from the current calendar month's own `attendance_records` (`monthStart = first of month`), relabeled **This month**; `weekRecs/weekStats` renamed to `monthRecs/monthStats`.

- **2026-08-25** (later 7) — **My Portal: employee attendance history.** New collapsible **Attendance History** band (below Today's Attendance) lets the employee browse their own past attendance by **month** (prev/next nav + "This month", next capped at the current month). Lazily loads that month's `attendance_records` for the signed-in `user_id` (permitted by the existing `own_all` RLS), shows a month summary (days present · total hours `Xh Ym` · on-time /days · late days) and a per-day list (weekday+date · In · Out · Duration · on-time/late/justified status · "corrected" marker). Answers the employee's "see my attendance over different history".

- **2026-08-25** (later 6) — **Admin/manager task assignment → employee Inbox.** New table `assigned_tasks` (title, details, `assignee_employee_id`→employees, assignee_name, assigned_by, priority Low/Medium/High, due_date, status Open/Done/Cancelled; `tko_set_updated_at` + `audit_trigger_fn` triggers). RLS: `tasks_manage` (admin/manager ALL), `tasks_own_read` (assignee reads own), `tasks_own_update` (assignee may flip own status Open/Done only, never reassign). New **Assign Tasks** page (`src/pages/AssignTasks.tsx`, `/tasks`, Admin group, admin/manager) to create a task for any employee (dropdown of employees; warns when the chosen person has no login account so it can't reach an Inbox), with a filterable Open/Done/Cancelled/All list and mark-done / cancel / reopen / delete. **Inbox** now has a **My tasks** section (open tasks assigned to me by employee-record id, with priority + due/overdue) and a **Mark done** button; these count toward the sidebar Inbox badge. `loadInbox` gained `myTasks` (matched by the account's linked employee ids) and `inboxCount` includes them.

- **2026-08-25** (later 5) — **Employees can change their own leave dates.** New RLS policy `own_update_leave` on `leave_records` lets a linked employee UPDATE their own request when it is currently Pending or Approved, with a `with_check` that only permits the resulting status to be Pending or Cancelled (they can never self-approve). In My Portal → My Requests, expanding a Pending/Approved leave row now shows **Change dates** (inline start/end pickers → saves and always lands the request back in **Pending** for HR to re-approve the final dates) and **Cancel request** (sets status Cancelled, with confirm). Approved requests show a hint that changing dates returns them to HR. Rejected/Cancelled requests are terminal (no actions). Employee requests (HR update / attendance correction) remain non-editable.

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
