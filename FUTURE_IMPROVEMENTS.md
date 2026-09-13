# TIME KEEPER — Future Improvements List

This file tracks confirmed future features that are NOT yet built.
Do not start building these until the current system is fully stable
and the relevant dependencies are ready.

---

## 1. Multi-item Sale

**Status:** Built. Quick Entry has "+ Add Item", lines are stored in `sale_items`,
and `cases.amount_kd` holds the basket total. Reports attribute revenue per item
(see item 5). Kept here for the requirements record.

**Why it matters:**
The current system only supports one item per Sale entry.
If a customer buys a watch, strap, and box in one visit, staff must log
3 separate entries — inflating the sale count and losing the fact that
it was one customer transaction.

**Requirements:**
- One Sale entry can contain multiple line items
- Default entry stays simple (one item) to keep staff flow fast
- Optional "+ Add Item" button only appears when needed
- Each item has:
  - Brand
  - Product Type
  - Product / Model name (optional)
  - Quantity
  - Amount
- Total amount auto-calculates from all items
- Staff performance counts the whole transaction as ONE sale
- Reports break down revenue by brand and product type across all items
- CRM customer history shows it as one transaction with multiple items

**Dependency:** Must decide CRM customer and transaction structure first.
Building multi-item sale before CRM is designed risks rebuilding it again.

---

## 2. CRM — Customer Profiles

**Status:** Not started. Waiting for multi-item sale structure to be confirmed first.

**Why it matters:**
Currently there are no customer records. Customer name and contact are
optional free-text fields on each case. There is no deduplication,
no customer history, and no way to see all transactions for one person.

**Requirements (to be defined):**
- Customer profile with name, contact, and history
- Link cases and sales to a customer record
- Handle duplicates (same phone number, similar names)
- Customer history shows all interactions, follow-ups, and purchases
- CRM must reflect multi-item sale structure correctly

**Dependency:** Multi-item Sale structure must be finalized first.

---

## 3. Per-outlet Staff Assignment (Optional)

**Status:** Partly built (2026-09-13). A personal login's outlet is pre-selected
from their HR record (`employees.location`) and the outlet screen is skipped;
it is a default, not a lock — the Quick Entry chip still switches outlets.

**Current behaviour:** Any staff member can log to any outlet.
**Proposed:** Assign staff to specific outlets so they only see their outlet by default.

---

## 4. Push Notifications for Overdue Follow-ups

**Status:** Not started.

**Proposed:** Notify staff or manager when a follow-up callback date passes
without a status update.

---

## 5. Reports — Brand and Product Type Breakdown

**Status:** Built. The daily PDF's Brand Analytics attributes revenue per line
item and sits beside a By Product Type table. Kept here for the record.

**Current behaviour:** Reports show total revenue and sale count only.
**Proposed:** Break down revenue by brand and product type in the daily report summary and PDF.

---

## Notes

- Do not start any item above until the current system passes full stability testing.
- Multi-item Sale and CRM are tightly linked — design them together.
- Keep the staff entry flow fast. Never add complexity to Quick Entry without a clear reason.
