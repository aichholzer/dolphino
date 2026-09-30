import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [],
  calls = [];
page.on("pageerror", (e) => errors.push(e.message));
let configured = false,
  slow = false,
  forbidden = false,
  cleanPreview = false,
  chat = {
    id: "chat_one",
    messages: [],
    status: "idle",
    expiresAt: Date.now() + 1800000,
  };
await page.route("**/api/**", async (route) => {
  const r = route.request(),
    path = new URL(r.url()).pathname;
  calls.push({
    path,
    query: new URL(r.url()).search,
    method: r.method(),
    body: r.postDataJSON(),
  });
  let data = {};
  if (path === "/api/session")
    data = {
      authenticated: true,
      demo: cleanPreview,
      user: { id: "admin", role: "admin", email: "admin@example.com" },
    };
  else if (path === "/api/dashboard")
    data = {
      incomeMinor: "665000",
      expensesMinor: "354874",
      netMinor: "310126",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    };
  else if (path === "/api/assistant/status")
    data = {
      enabled: configured,
      configured,
      disclosure:
        "I agree to send authorized financial data to the configured provider.",
    };
  else if (path === "/api/assistant/chats" && r.method() === "GET")
    data = { chats: chat.messages.length ? [chat] : [] };
  else if (path === "/api/assistant/chats" && r.method() === "POST")
    data = chat;
  else if (path === "/api/assistant/chats/chat_one/cancel") {
    chat.status = "idle";
    data = { cancelled: true };
  } else if (path === "/api/assistant/chats/chat_one/messages") {
    if (slow) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      data = { chat, reply: "Cancelled result should not render" };
    } else {
      chat = {
        ...chat,
        messages: [
          ...chat.messages,
          { role: "user", content: r.postDataJSON().message },
          {
            role: "assistant",
            content: cleanPreview
              ? "Demo answer · fictional data only.\n\nSeptember spending was AUD 3,548.74. Housing was AUD 2,100.00. Transfers are excluded and refunds reduce spending.\n\nCheck the source report below."
              : "Spending is AUD 123.45. <img src=x onerror=alert(1)> [external](https://unsafe.example)",
            citations: [
              {
                id: "result_1",
                label: "Authorized monthly report",
                tool: "monthly_report",
                provenance: { currency: "USD" },
                reportId: "report_123",
                reference: {
                  type: "transaction",
                  id: "11111111-1111-4111-8111-111111111111",
                },
              },
            ],
          },
        ],
      };
      data = {
        chat,
        reply: chat.messages.at(-1).content,
        citations: chat.messages.at(-1).citations,
      };
    }
  } else if (path === "/api/assistant/chats/chat_one") {
    if (forbidden) {
      await route.fulfill({
        status: 403,
        json: { error: "Conversation unavailable" },
      });
      return;
    }
    data = chat;
  }
  await route.fulfill({ json: data });
});
try {
  await page.goto(process.env.PROFE_TEST_URL || "http://localhost:3001");
  await page.getByRole("button", { name: "Ask Profe", exact: true }).click();
  await page
    .getByRole("heading", { name: "Your assistant is not enabled yet" })
    .waitFor();
  assert(
    await page.getByRole("button", { name: "Send", exact: true }).isDisabled(),
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Ask Profe", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  configured = true;
  await page.getByRole("button", { name: "Ask Profe", exact: true }).click();
  await page
    .getByRole("heading", { name: "A little help making sense of it." })
    .waitFor();
  await page
    .getByLabel("Ask a financial question", { exact: true })
    .fill("Compare my authorized spending");
  assert(
    await page.getByRole("button", { name: "Send", exact: true }).isDisabled(),
  );
  await page
    .getByRole("checkbox", {
      name: "I agree to send authorized financial data to the configured provider.",
    })
    .check();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Authorized monthly report", { exact: true }).waitFor();
  assert.equal(await page.locator(".assistant-message img").count(), 0);
  assert.equal(
    await page.locator('.assistant-message a[href^="https:"]').count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "Download authorized report" })
      .getAttribute("href"),
    "/api/assistant/reports/report_123",
  );
  assert(
    calls.some(
      (c) =>
        c.path.endsWith("/messages") && c.body.acknowledgeDataSharing === true,
    ),
  );
  await page.screenshot({
    path: "artifacts/profe-assistant-desktop.png",
    fullPage: false,
  });
  slow = true;
  await page
    .getByLabel("Ask a financial question", { exact: true })
    .fill("A synthetic slow question");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop response", exact: true })
    .click();
  await page.waitForTimeout(750);
  assert.equal(
    await page
      .getByText("Cancelled result should not render", { exact: true })
      .count(),
    0,
  );
  assert(calls.some((c) => c.path.endsWith("/cancel")));
  forbidden = true;
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page
    .getByLabel("Assistant conversation", { exact: true })
    .selectOption("chat_one");
  await page.getByText("Conversation unavailable", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Authorized monthly report", { exact: true }).count(),
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator("body").evaluate((e) => e.scrollWidth <= innerWidth),
    true,
  );
  await page.screenshot({
    path: "artifacts/profe-assistant-mobile.png",
    fullPage: false,
  });
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    assert(
      await page
        .getByRole("dialog")
        .evaluate((el) => el.contains(document.activeElement)),
      "focus stays in assistant dialog",
    );
  }
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("dialog").count(), 0);
  cleanPreview = true;
  slow = false;
  forbidden = false;
  chat = {
    id: "chat_one",
    messages: [],
    status: "idle",
    expiresAt: Date.now() + 1800000,
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole("button", { name: "Ask Profe", exact: true }).click();
  await page
    .getByRole("heading", { name: "A little help making sense of it." })
    .waitFor();
  await page
    .getByRole("checkbox", {
      name: "I agree to send authorized financial data to the configured provider.",
    })
    .check();
  await page
    .getByLabel("Ask a financial question", { exact: true })
    .fill(
      "Using the fictional demo, summarize September spending and provide the source report.",
    );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Authorized monthly report", { exact: true }).waitFor();
  await page.screenshot({
    path: "artifacts/profe-assistant-desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "artifacts/profe-assistant-mobile.png",
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "View source transaction", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Every little detail.", exact: true })
    .waitFor();
  assert(
    calls.some(
      (c) =>
        c.path === "/api/transactions" &&
        c.query.includes("ids=11111111-1111-4111-8111-111111111111") &&
        c.query.includes("currency=USD"),
    ),
    "server validated reference drills into scoped transactions",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Assistant browser checks passed: unavailable config, explicit sharing acknowledgment, plaintext/XSS-safe reply, authorized report link, abort/cancel late-result protection, forbidden conversation hides history, responsive mobile focus trap/Escape. All APIs mocked.",
  );
} finally {
  await browser.close();
}
