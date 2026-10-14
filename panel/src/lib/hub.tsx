import { createContext, useContext } from 'react';
import type { HubStatus } from '../api/types';

/** What the shell already knows about the hub (counts, time zone, uptime), shared with the pages. */
export const HubContext = createContext<HubStatus | undefined>(undefined);
export const useHub = (): HubStatus | undefined => useContext(HubContext);

export const hubTimeZone = (hub: HubStatus | undefined): string => hub?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
