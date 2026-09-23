// The version on screen and the notes behind it must agree.
//
// The shop app said 1.2.14 for ten days and 69 changes, because the number was
// only ever changed by hand and nothing noticed when it was not. This does not
// decide when to release — that is a person's call — but it refuses a build
// where the number in package.json has no notes, or the notes describe a
// version that is not the one being shipped.
//
// Mirrored byte-for-byte in timekeeper-online and watch-store-crm.
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
let releases
try {
  releases = JSON.parse(readFileSync(new URL('../src/releases.json', import.meta.url), 'utf8'))
} catch (err) {
  console.error(`  releases: src/releases.json could not be read — ${err.message}`)
  process.exit(1)
}

const problems = []
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const parts = (v) => v.match(SEMVER).slice(1).map(Number)
// JavaScript reads 2026-02-31 as 3 March rather than refusing it, so a date is
// only real if it survives the round trip unchanged.
const realDay = (d) => typeof d === 'string' && DAY.test(d) &&
  new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

if (!Array.isArray(releases) || releases.length === 0) {
  problems.push('src/releases.json must be a list with at least one release')
} else {
  releases.forEach((r, i) => {
    const at = `release ${i + 1}${r?.version ? ` (${r.version})` : ''}`
    if (typeof r?.version !== 'string' || !SEMVER.test(r.version)) problems.push(`${at}: version must look like 2.0.0`)
    if (!realDay(r?.date))
      problems.push(`${at}: date must be a real day, written 2026-09-23`)
    if (typeof r?.title !== 'string' || !r.title.trim()) problems.push(`${at}: needs a title`)
    if (!Array.isArray(r?.changes) || r.changes.length === 0 || r.changes.some((c) => typeof c !== 'string' || !c.trim()))
      problems.push(`${at}: needs at least one change, each a line of text`)
  })

  // newest first, each version once, dates never going forwards down the list
  for (let i = 1; i < releases.length; i++) {
    const [a, b] = [releases[i - 1], releases[i]]
    if (!SEMVER.test(a?.version ?? '') || !SEMVER.test(b?.version ?? '')) continue
    if (!newer(a.version, b.version)) problems.push(`${a.version} is listed above ${b.version} but is not newer — newest goes first, each version once`)
    if (DAY.test(a?.date ?? '') && DAY.test(b?.date ?? '') && a.date < b.date)
      problems.push(`${a.version} is dated ${a.date}, earlier than ${b.version} below it (${b.date})`)
  }

  const top = releases[0]?.version
  if (top !== pkg.version && SEMVER.test(top ?? '') && SEMVER.test(pkg.version)) {
    problems.push(newer(top, pkg.version)
      ? `the newest notes are for ${top} but package.json still says ${pkg.version} — run: npm version ${top} --no-git-tag-version`
      : `package.json says ${pkg.version} but there are no notes for it — add a ${pkg.version} entry at the top of src/releases.json`)
  } else if (top !== pkg.version) {
    problems.push(`package.json says ${pkg.version} but the newest notes are for ${top}`)
  }
}

if (problems.length) {
  console.error('  releases: the version and its notes disagree')
  for (const p of problems) console.error(`    - ${p}`)
  process.exit(1)
}
console.log(`  releases: ${pkg.version} (${releases[0].date}), ${releases.length} release${releases.length === 1 ? '' : 's'} recorded`)
