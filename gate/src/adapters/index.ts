import type { ProviderType } from '../types.js';
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
import type { Adapter } from './types.js';

const ADAPTERS: Record<ProviderType, Adapter> = { openai: openaiAdapter, anthropic: anthropicAdapter };

export const adapterFor = (type: ProviderType): Adapter => ADAPTERS[type];
export type { Adapter, ChatCall, ChatResult, Json, StreamItem } from './types.js';
