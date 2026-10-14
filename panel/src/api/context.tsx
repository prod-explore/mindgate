import { createContext, useContext, type ReactNode } from 'react';
import { createApi, type Api } from './client';
import { getToken, signOut } from '../lib/session';

/** The one client the app talks through; tests hand in a fake. */
export const defaultApi: Api = createApi({ token: getToken, onAuthFailed: () => signOut(true) });

const Ctx = createContext<Api>(defaultApi);
export const ApiProvider = ({ api, children }: { api: Api; children: ReactNode }) => <Ctx.Provider value={api}>{children}</Ctx.Provider>;
export const useApi = (): Api => useContext(Ctx);
