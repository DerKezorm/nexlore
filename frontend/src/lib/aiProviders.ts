/**
 * Tiles that fill in the address of a common AI service. The server knows none of them: any address that speaks the
 * usual chat interface is just as good ("Other address"). Only the address and where to get a key are said here, no
 * prices or conditions: those change, and a sentence that aged quietly is worse than a link.
 */
/** `embeddings`: the service also turns text into vectors (finding notes by meaning, `services/meaning.py`). */
export type AiProvider = { name: string; url: string; keys: string | null; embeddings: boolean }

export const AI_PROVIDERS: AiProvider[] = [
  { name: 'Anthropic', url: 'https://api.anthropic.com/v1/', keys: 'https://console.anthropic.com/settings/keys', embeddings: false },
  { name: 'OpenAI', url: 'https://api.openai.com/v1/', keys: 'https://platform.openai.com/api-keys', embeddings: true },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/', keys: 'https://openrouter.ai/settings/keys', embeddings: true }, // vectors: not tried yet
  // At home: nothing leaves the network. The address of the computer Ollama runs on, as nexlore's server reaches it.
  { name: 'Ollama', url: 'http://localhost:11434/v1/', keys: null, embeddings: true },
]
