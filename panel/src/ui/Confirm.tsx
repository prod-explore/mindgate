import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
const Ctx = createContext<ConfirmFn>(() => Promise.resolve(false));

/** `if (await confirm({ title: 'Delete the key?', danger: true })) …` — one dialog for every "are you sure". */
export const useConfirm = (): ConfirmFn => useContext(Ctx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>(
    options =>
      new Promise<boolean>(resolve => {
        resolver.current?.(false);
        resolver.current = resolve;
        setPending(options);
      }),
    [],
  );

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setPending(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {pending ? (
        <Dialog
          title={pending.title}
          onClose={() => settle(false)}
          onSubmit={() => settle(true)}
          footer={
            <>
              <Button onClick={() => settle(false)}>{t('common.cancel')}</Button>
              <Button type="submit" variant={pending.danger ? 'danger' : 'primary'} autoFocus>
                {pending.confirmLabel ?? t('common.confirm')}
              </Button>
            </>
          }
        >
          {pending.body}
        </Dialog>
      ) : null}
    </Ctx.Provider>
  );
}
