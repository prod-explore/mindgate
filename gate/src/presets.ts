/** Starting points for the "add provider" form. Nothing here is special-cased anywhere else. */
export const PRESETS = [
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', base_url: 'https://openrouter.ai/api/v1', locality: 'cloud', options: { auto_enable_models: false }, note: 'Hundreds of models: they are discovered disabled, switch on the ones you want.' },
  { id: 'gemini', name: 'Google Gemini', type: 'openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', locality: 'cloud', note: "Google's OpenAI-compatible endpoint. Create a key at aistudio.google.com." },
  { id: 'anthropic', name: 'Anthropic', type: 'anthropic', base_url: 'https://api.anthropic.com/v1', locality: 'cloud', note: 'Native Messages API, presented as OpenAI chat completions.' },
  { id: 'openai', name: 'OpenAI', type: 'openai', base_url: 'https://api.openai.com/v1', locality: 'cloud' },
  { id: 'ollama', name: 'Ollama', type: 'openai', base_url: 'http://localhost:11434/v1', locality: 'local', auth_scheme: 'none', note: 'Runs on your own hardware. Ollama has no authentication; keep it off the open network.' },
  { id: 'lmstudio', name: 'LM Studio', type: 'openai', base_url: 'http://localhost:1234/v1', locality: 'local', auth_scheme: 'none' },
  { id: 'custom', name: 'Other OpenAI-compatible server', type: 'openai', base_url: 'http://localhost:8000/v1', locality: 'cloud', note: 'vLLM, llama.cpp, a subscription wrapper, another MindGate... Mark it local only if it really runs on your hardware.' },
] as const;
