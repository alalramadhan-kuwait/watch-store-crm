/// <reference types="vite/client" />

/** Short git SHA of the commit this build came from; '' in local dev. Set in vite.config.ts. */
declare const __BUILD_SHA__: string;

/** Set once React has rendered, so the boot failsafe in index.html stands down. */
interface Window { __booted?: boolean }
