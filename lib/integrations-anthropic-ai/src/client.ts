import Anthropic from "@anthropic-ai/sdk";

// Supports either a user-provided key (ANTHROPIC_API_KEY, using the default
// Anthropic API) or the Replit AI Integrations proxy (AI_INTEGRATIONS_*).
const apiKey = (
  process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY
)?.trim();

if (!apiKey) {
  throw new Error(
    "ANTHROPIC_API_KEY must be set. Add your Anthropic API key to enable AI features.",
  );
}

const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;

export const anthropic = new Anthropic({
  apiKey,
  ...(baseURL ? { baseURL } : {}),
});
