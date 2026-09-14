import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// The commit a build came from, stamped into the UI next to the version so
// staff can see a fresh deploy reached their phone. CI sets GITHUB_SHA; a
// local dev build has none and shows just the version.
const buildSha = (process.env.GITHUB_SHA ?? '').slice(0, 7)

/* The service worker ships as a plain file in public/, because it has to be
 * served from the site root to control the whole app and must not go through
 * the module pipeline. But it cannot know Vite's content-hashed filenames until
 * the build has run, so they are written into it here.
 *
 * The build id is a hash of that list, which means it changes when — and only
 * when — the output changes. That is what a browser compares to decide a worker
 * is new, so an unchanged build never nags anyone about an update and a changed
 * one always reaches them. */
function serviceWorkerManifest(): Plugin {
  return {
    name: 'dsr-service-worker-manifest',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      const out = options.dir ?? 'dist'
      const sw = resolve(out, 'sw.js')
      if (!existsSync(sw)) return

      const assets = Object.keys(bundle)
        .filter((f) => /\.(js|css)$/.test(f))
        .sort()
        .map((f) => './' + f)

      const precache = [
        './',
        './index.html',
        './manifest.webmanifest',
        './icon-192.png',
        './icon-512.png',
        './icon-maskable-512.png',
        './apple-touch-icon.png',
        './fonts/josefin-sans-latin.woff2',
        ...assets,
      ]

      const build = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12)

      let src = readFileSync(sw, 'utf8')
      src = src.replace("const BUILD = '__BUILD__';", `const BUILD = '${build}';`)
      src = src.replace(/const PRECACHE = \[[^\]]*\];/, 'const PRECACHE = ' + JSON.stringify(precache, null, 2) + ';')
      if (src.includes('__BUILD__')) throw new Error('the service worker build placeholder was not replaced')
      writeFileSync(sw, src)
      // eslint-disable-next-line no-console
      console.log(`  service worker: build ${build}, ${precache.length} files precached`)
    },
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react(), serviceWorkerManifest()],
  base: command === 'build' ? '/watch-store-crm/' : '/',
  define: { __BUILD_SHA__: JSON.stringify(buildSha) },
}))
