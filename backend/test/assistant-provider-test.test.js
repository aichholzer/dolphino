import test from "node:test";
import assert from "node:assert/strict";
import { testAssistantModel } from "../src/assistant-provider-test.js";
const config = {
  llmProvider: "openai",
  llmApiKey: "synthetic-test-key",
  llmModel: "fictional-model",
  assistantMaxOutputTokens: 1024,
  llmEnabled: false,
};
test("assistant synthetic model test uses real tool contract, only fixed data, two bounded mocked requests", async () => {
  let requests = 0;
  const result = await testAssistantModel(config, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests++;
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 256);
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].name, "synthetic_budget_summary");
      if (requests === 1)
        return Response.json({
          output: [
            {
              type: "function_call",
              call_id: "synthetic_call",
              name: "synthetic_budget_summary",
              arguments: "{}",
            },
          ],
        });
      const tool = body.input.find((i) => i.type === "function_call_output");
      assert.equal(tool.call_id, "synthetic_call");
      assert.deepEqual(JSON.parse(tool.output), {
        fictional: true,
        currency: "AUD",
        amountMinor: "1234",
        amount: "12.34",
      });
      return Response.json({
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "Fictional amount AUD12.34" },
            ],
          },
        ],
      });
    },
  });
  assert.equal(requests, 2);
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes("synthetic-test-key"));
});
test("assistant synthetic model test refuses unsupported tools without executing data access", async () => {
  let requests = 0;
  await assert.rejects(
    testAssistantModel(config, {
      fetchImpl: async () => {
        requests++;
        return Response.json({
          output: [
            {
              type: "function_call",
              call_id: "call",
              name: "read_private_accounts",
              arguments: "{}",
            },
          ],
        });
      },
    }),
    /synthetic assistant tool contract/,
  );
  assert.equal(requests, 1);
});
