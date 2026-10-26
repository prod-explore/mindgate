import { readFileSync } from 'node:fs';

/** The hub's version, read from package.json (one level above dist/) so the manifest stays the single source. */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
