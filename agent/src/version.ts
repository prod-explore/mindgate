import { readFileSync } from 'node:fs';

/**
 * The agent's version, read from package.json (one level above dist/) so the manifest stays the single source.
 * A missing or unreadable manifest is a broken install, so the import throws instead of reporting a made-up version.
 */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
