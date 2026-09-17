# Shared foundation

These files are **mirrored byte-for-byte** between `timekeeper-online` and
`watch-store-crm`. They exist so the two apps give the same answer from the same
data: one outlet identity, one worked-hours calculation, one attendance status,
one schedule reading, one store open/close rule.

| File | Answers |
| --- | --- |
| `outlets.ts` | Which outlet is this, and is it a shop or a channel? |
| `workedHours.ts` | How many hours did this person work? |
| `schedule.ts` | When were they expected to work — on *that* date? |
| `attendanceStatus.ts` | Where do they stand today? |
| `storeDay.ts` | When did the shop open and close? |
| `portal.ts` | What My Portal asks the database, and what a valid answer is. |
| `workload.ts` | Over a period, who carried how much — and is that fair? |
| `live.ts` | Keeping a current-day screen up to date without polling. |

`portal.ts` and `live.ts` are the two files here that talk to the network. It imports the
`supabase` client from `../lib/supabase`, which exists at that path in both
apps. Everything else is pure and can be tested without a database.

Each has a counterpart in the database (`resolve_outlet`, `attendance_shifts`,
`attendance_day_hours`, `schedule_on`, `store_day`) applying the same rules to
reports and exports. If you change a rule here, change it there too.

## Editing

1. Edit the file in **one** repo.
2. Run `npm run shared:hash` and commit the updated `MANIFEST.json`.
3. Copy the changed files and `MANIFEST.json` into the other repo.

`npm test` fails if a file here does not match `MANIFEST.json`, which catches an
edit made in one app and forgotten in the other. The two repos agree when their
`foundation` hashes match — both print it.

## Rules worth not rediscovering

- **An open shift is hours-so-far, never zero.** Three screens used to report 0.
- **A shift open longer than 16 hours was never clocked out.** Its length is
  unknown (`null`), not enormous. Ten such records existed when this was written,
  the oldest running for six weeks.
- **Nobody is absent just because they are not here.** Only flag a person on a
  day the schedule in force *on that date* says they were expected.
- **Digital channels are not shops.** Online and WhatsApp sell, but have no
  attendance, no geofence and no opening time.
- **Never compare outlet text with `===`.** Four systems spell these four
  outlets four different ways.
- **Realtime is for today only.** A subscription on a historical report is
  traffic nobody benefits from. And a table delivers nothing at all unless it is
  in the `supabase_realtime` publication — two screens subscribed for months
  without it and quietly received nothing.
