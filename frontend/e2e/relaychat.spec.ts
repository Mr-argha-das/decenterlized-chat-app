import { expect, test } from "@playwright/test";

test.describe("RelayChat Production-Like End-to-End Suite (Signup, Chat, File, Call, Group & Status)", () => {
  test("1. Two users sign up with browser Web Crypto keys, exchange E2EE 1:1 messages, send an encrypted file, place a call, and chat in a Sender-Keys group", async ({
    browser,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const aliceUser = `alice_${suffix}`;
    const bobUser = `bob_${suffix}`;
    const pass = "StrongPass#2026";

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alicePage = await aliceCtx.newPage();
    const bobPage = await bobCtx.newPage();

    // --- A. SIGNUP (Alice & Bob) ---
    await alicePage.goto("/signup");
    await alicePage.getByPlaceholder(/username/i).fill(aliceUser);
    await alicePage.getByPlaceholder(/display name/i).fill("Alice E2E");
    await alicePage.locator('input[type="password"]').first().fill(pass);
    await alicePage.getByRole("button", { name: /create|sign up/i }).click();
    await expect(alicePage.getByTestId("open-new-chat-button")).toBeVisible({
      timeout: 20_000,
    });

    await bobPage.goto("/signup");
    await bobPage.getByPlaceholder(/username/i).fill(bobUser);
    await bobPage.getByPlaceholder(/display name/i).fill("Bob E2E");
    await bobPage.locator('input[type="password"]').first().fill(pass);
    await bobPage.getByRole("button", { name: /create|sign up/i }).click();
    await expect(bobPage.getByTestId("open-new-chat-button")).toBeVisible({
      timeout: 20_000,
    });

    // --- B. 1:1 E2EE CHAT ---
    await alicePage.getByTestId("open-new-chat-button").click();
    await alicePage.getByPlaceholder(/username|handle|search/i).first().fill(bobUser);
    await alicePage.getByText("Bob E2E").first().click();

    const chatMsg = `Hello Bob! E2EE verified at ${suffix}`;
    const composer = alicePage.locator("textarea").first();
    await composer.fill(chatMsg);
    await composer.press("Enter");

    await expect(alicePage.getByText(chatMsg)).toBeVisible();
    await bobPage.getByText("Alice E2E").first().click();
    await expect(bobPage.getByText(chatMsg)).toBeVisible({ timeout: 15_000 });

    // --- C. ENCRYPTED FILE SEND ---
    const fileChooserPromise = alicePage.waitForEvent("filechooser");
    await alicePage.locator('button[aria-label*="Attach"], button[title*="Attach"]').first().click();
    await alicePage.getByTestId("attach-option-document").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "secret-architecture.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Confidential E2EE file payload"),
    });
    await alicePage.getByRole("button", { name: /send/i }).click();
    await expect(bobPage.getByText("secret-architecture.txt")).toBeVisible({
      timeout: 15_000,
    });

    // --- D. LIVE 1:1 CALL SIGNALING ---
    await alicePage.getByRole("button", { name: /voice call/i }).click();
    await expect(alicePage.getByTestId("active-call-modal")).toBeVisible();
    await expect(bobPage.getByTestId("incoming-call-modal")).toBeVisible({
      timeout: 10_000,
    });
    await bobPage.getByTestId("accept-call-button").click();
    await alicePage.getByTestId("end-call-button").click();

    // --- E. ENCRYPTED SENDER-KEYS GROUP ---
    await alicePage.getByRole("button", { name: /main menu/i }).click();
    await alicePage.getByText(/new encrypted group/i).click();
    await alicePage.getByPlaceholder(/group name/i).fill(`Core Team ${suffix}`);
    await alicePage.getByText("Bob E2E").first().click();
    await alicePage.getByRole("button", { name: /create group/i }).click();

    const groupMsg = `Welcome to our Sender-Keys group ${suffix}!`;
    await alicePage.locator("textarea").first().fill(groupMsg);
    await alicePage.locator("textarea").first().press("Enter");

    await bobPage.getByText(`Core Team ${suffix}`).first().click();
    await expect(bobPage.getByText(groupMsg)).toBeVisible({ timeout: 15_000 });

    await aliceCtx.close();
    await bobCtx.close();
  });
});
