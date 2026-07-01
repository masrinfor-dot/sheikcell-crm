---
name: AI provider (OpenAI, own key)
description: How AI features authenticate and which model to use for the Sheikcell chat AI features
---

# AI provider

AI reply suggestions use OpenAI **directly with the user's own API key** — not the Replit AI Integrations proxy.

- Secret: `OPENAI_API_KEY` (key format `sk-proj-...`). Client also falls back to `AI_INTEGRATIONS_OPENAI_API_KEY` + `AI_INTEGRATIONS_OPENAI_BASE_URL` if the proxy is ever wired.
- Lib: `lib/integrations-openai-ai` exports `openai` (the SDK client). Route imports it lazily inside try/catch so the server still boots without a key; the AI call then fails with 503.
- Model: `gpt-4o` (verified working against the user's real key). Chat Completions API.

**Why:** the project briefly used Anthropic (`claude-sonnet-4-6`), but that model name is a Replit-proxy alias and the user's key is an OpenAI key, so `api.anthropic.com` rejected it with `401 invalid x-api-key`. Provider was swapped to OpenAI at the user's request.

**How to apply:** Replit-proxy model aliases (e.g. `gpt-5.4`, `claude-sonnet-4-6`) do NOT exist on the real vendor APIs. When using a user's own key, verify the model name against the live API before shipping. Always `.trim()` keys read from env — secrets can carry a trailing newline that breaks the auth header.
