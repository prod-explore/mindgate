import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../lib/cx';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  pending?: boolean;
}

export function Button({ variant = 'default', size = 'md', pending, className, disabled, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', pending && 'is-pending', className)} disabled={disabled || pending} aria-busy={pending || undefined} {...rest}>
      {children}
    </button>
  );
}
