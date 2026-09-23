# Working agreement

## Database work

This project shares one Supabase project (`ttshgrujnycapugrmyxs`) with the
`timekeeper-online` repo (the back office). Schema changes affect both apps.

**Do not ask for permission for routine SQL.** Reads, queries, schema
inspection, and non-destructive migrations are pre-approved in
`.claude/settings.json` and run without interrupting. This includes new tables
and columns, functions, views, indexes, RLS and policy changes, backfills, and
realtime publication changes.

**Batch the work into one migration.** A feature that needs six schema changes
gets one migration with all six in it, not six `execute_sql` calls. Combining
them means one thing to review, one thing to roll back, and one file in
`supabase/migrations/` that matches what actually happened. The same applies to
read-only investigation: combine questions into one query rather than sending
them one at a time.

**If something does need approval, ask once for the whole thing.** Never
approve-then-ask-again partway through a change. Present the complete set,
including anything destructive it depends on, as a single request.

**Stop and ask only for genuine destruction:** dropping a table, column or
schema; truncating; deleting a meaningful amount of production data; resetting
the database; an irreversible rewrite of historical records. A guard hook in
`.claude/settings.json` catches the common shapes (DROP, TRUNCATE, DELETE with
no WHERE) and prompts, but it is a backstop, not the rule — judge the change,
not the keyword.

**Write the migration file.** Anything applied to the database gets a matching
file in `supabase/migrations/`, named with the version the database actually
recorded, in **both** repos. The folder must be able to rebuild the database in
order; it has silently drifted from it before.

## The shared foundation

`src/shared/` is mirrored **byte for byte** between this repo and the back office. It
holds the outlet registry, worked-hours, schedule, punctuality, attendance
status and portal rules that both apps must agree on.

After editing anything in it: run `npm run shared:hash`, copy the directory
(including `__tests__/` and `MANIFEST.json`) to the other repo, and confirm both
builds print the same foundation hash. `npm run build` checks this and fails if
they have drifted.

## Releases

Each app has a version (`package.json`) and plain-language notes for it
(`src/releases.json`, newest first). Staff see both: tapping the version under
the title opens What's new. `npm run build` fails if the newest notes are not
for the version in `package.json` (`scripts/release-check.mjs`).

**Bump the version when a change reaches the people using the app**, in the
same commit as the change:

- **major** (3.0.0) — changes how people do their daily work: a new flow, screens moved.
- **minor** (2.1.0) — something new they can do.
- **patch** (2.0.1) — a fix, or an improvement they would barely notice.

Several fixes shipped together can share one patch. Work nobody using the app
would notice — docs, tests, refactors — needs no bump.

Run `npm version X.Y.Z --no-git-tag-version` so the lockfile follows, then add
the entry at the top of `src/releases.json`: one short line per change a user
would notice, in their words rather than ours.

**Do not tag by hand.** When a version first deploys, CI tags that commit
`vX.Y.Z`. The two apps are numbered independently. SYSTEM.md's Changelog
remains the technical record of how things changed; the release notes are for
the people using the app.
