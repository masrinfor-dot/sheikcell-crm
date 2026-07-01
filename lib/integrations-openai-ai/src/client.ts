import OpenAI from "openai";

// Supports either a user-provided key (OPENAI_API_KEY, using the default
// OpenAI API) or the Replit AI Integrations proxy (AI_INTEGRATIONS_*).
const apiKey = (
  process.env.OPENAI_API_KEY ?? process.env.AI_INTEGRATIONS_OPENAI_API_KEY
)?.trim();

if (!apiKey) {
  throw new Error(
    "OPENAI_API_KEY must be set. Add your OpenAI API key to enable AI features.",
  );
}

const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

export const openai = new OpenAI({
  apiKey,
  ...(baseURL ? { baseURL } : {}),
});
