import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { toasts } from '../lib/toast';

// toasts live in a module-wide store: one test's messages must not show up in the next
afterEach(() => {
  cleanup();
  toasts.set([]);
});

// jsdom has <dialog> but not its modal behaviour
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}
