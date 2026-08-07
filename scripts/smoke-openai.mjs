/**
 * One-shot OpenAI connectivity check using the same Responses API shape
 * as OpenAiProvider. Does not write secrets to disk.
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/smoke-openai.mjs
 *   OPENAI_API_KEY=... node scripts/smoke-openai.mjs gpt-5.6-sol none
 */
const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.argv[2] || "gpt-5.6-sol";
const reasoning = process.argv[3] || "none";

if (!apiKey) {
  console.error("OPENAI_API_KEY is required.");
  process.exit(1);
}

const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    instructions: "Reply with a tiny JSON object only.",
    input: [{
      role: "user",
      content: [{ type: "input_text", text: "Say hello. This is a connectivity test only. Return JSON {\"message\":\"hello\"}." }],
    }],
    text: {
      format: {
        type: "json_schema",
        name: "hello_smoke",
        strict: true,
        schema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
    max_output_tokens: 64,
    reasoning: { effort: reasoning },
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
  reasoning,
  status: body.status ?? null,
  message: text,
  usage: body.usage ?? null,
}, null, 2));

function extractText(payload) {
  for (const item of payload.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return JSON.stringify(payload).slice(0, 400);
}
