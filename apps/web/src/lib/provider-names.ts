// Pure provider-name formatting — safe to import from client components.
// Lives in its own module (not in llm-providers.ts) because that file uses
// `server-only` env access for getConfiguredLlmProviders.

export function prettyProviderName(slug: string): string {
  switch (slug) {
    case 'openai-compatible':
      return 'Local LLM'; // wizard maps lm-studio/jan-ai/etc to openai-compatible
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'ollama':
      return 'Ollama';
    case 'openrouter':
      return 'OpenRouter';
    case 'google':
      return 'Google';
    case 'mistral':
      return 'Mistral';
    case 'groq':
      return 'Groq';
    case 'deepseek':
      return 'DeepSeek';
    case 'minimax':
      return 'MiniMax';
    default:
      return slug;
  }
}
