import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The commit a build came from, stamped into the UI next to the version so
// staff can see a fresh deploy reached their phone. CI sets GITHUB_SHA; a
// local dev build has none and shows just the version.
const buildSha = (process.env.GITHUB_SHA ?? '').slice(0, 7)

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/watch-store-crm/' : '/',
  define: { __BUILD_SHA__: JSON.stringify(buildSha) },
}))
