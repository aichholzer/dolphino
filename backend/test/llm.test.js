import test from "node:test";
import assert from "node:assert/strict";
import { suggestCategory } from "../src/llm.js";
test("LLM disabled by default and minimises configured payload, suggestions require review", async () => {
  await assert.rejects(
    suggestCategory({ description: "test" }, ["Food"], {}),
    /disabled/,
  );
  let sent;
  const result = await suggestCategory(
    {
      description: "SHOP 12345678",
      amountMinor: "-12345",
      accountId: "private",
      date: "2026-09-30",
    },
    ["Food"],
    {
      llmApiKey: "fictional",
      llmProvider: "openai",
      llmModel: "small",
    },
    async (_url, options) => {
      sent = JSON.parse(options.body);
      return Response.json({
        choices: [
          { message: { content: '{"category":"Food","reason":"A shop"}' } },
        ],
      });
    },
  );
  assert.equal(result.requiresReview, true);
  const payload = JSON.parse(sent.messages[1].content);
  assert.deepEqual(Object.keys(payload), ["description", "categories"]);
  assert(!payload.description.includes("12345678"));
});
test("LLM rejects invalid category and legacy arbitrary endpoints", async () => {
  const config = {
    llmApiKey: "fictional",
    llmProvider: "openai",
    llmModel: "small",
  };
  await assert.rejects(
    suggestCategory({ description: "Shop" }, ["Food"], config, async () =>
      Response.json({
        choices: [
          { message: { content: '{"category":"Unknown","reason":"?"}' } },
        ],
      }),
    ),
    /unknown category/,
  );
  await assert.rejects(
    suggestCategory({ description: "Shop" }, ["Food"], {
      ...config,
      llmProvider: undefined,
      llmBaseUrl: "https://example.com",
    }),
    /disabled/,
  );
});
