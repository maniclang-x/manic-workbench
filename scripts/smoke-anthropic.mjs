/**
 * One-shot Anthropic connectivity check using the same Messages API shape
 * as AnthropicProvider. Does not write secrets to disk.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... node scripts/smoke-anthropic.mjs
 *   ANTHROPIC_API_KEY=... node scripts/smoke-anthropic.mjs claude-sonnet-5
 *   ANTHROPIC_API_KEY=... node scripts/smoke-anthropic.mjs claude-haiku-4-5-20251001
 */
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const model = process.argv[2] || "claude-sonnet-5";

if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

const schema = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
};

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    max_tokens: 64,
    system: "Reply with a tiny JSON object only.",
    messages: [{
      role: "user",
      content: [{ type: "text", text: "Say hello. This is a connectivity test only. Return JSON {\"message\":\"hello\"}." }],
    }],
    output_config: {
      format: {
        type: "json_schema",
        schema,
      },
    },
  }),
});

const body = await response.json();
if (!response.ok) {
  const message = body?.error?.message || JSON.stringify(body);
  console.error(`FAIL ${response.status}: ${message}`);
  process.exit(1);
}

const text = extractText(body);
console.log(JSON.stringify({
  ok: true,
  model,
  stop_reason: body.stop_reason ?? null,
  message: text,
  usage: body.usage ?? null,
}, null, 2));

function extractText(payload) {
  for (const part of payload.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") return part.text;
  }
  return JSON.stringify(payload).slice(0, 400);
}
