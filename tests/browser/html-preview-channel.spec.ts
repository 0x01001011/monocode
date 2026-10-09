import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// The exact script the preview scheme injects, read from the Rust source.
function bootstrap(): string {
  const source = readFileSync("src-tauri/src/html_preview.rs", "utf8");
  const block = source.match(/const BOOTSTRAP: &str = concat!\(([\s\S]*?)\n\);/)?.[1];
  if (!block) throw new Error("BOOTSTRAP not found in html_preview.rs");
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
    .join("");
}

const NONCE = "mc:browsertest";

async function open(page: Page, { name = NONCE, pageScript = "" } = {}) {
  await page.route("**/preview-test/page.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head>${bootstrap()}</head><body>
        <input id="field" aria-label="field">
        <a id="ext" href="https://example.com/x?y=1">external</a>
        <a id="rel" href="/preview-test/page2.html">next page</a>
        <script>${pageScript}</script></body></html>`,
    }),
  );
  await page.route("**/preview-test/page2.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head>${bootstrap()}</head><body><p id="second">second page</p></body></html>`,
    }),
  );
  // If a click leaves the preview this page loads, and the test sees it.
  await page.route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: `<p id="external">external</p>` }),
  );
  await page.route("**/preview-test/host.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body>
        <iframe id="f" ${name ? `name="${name}"` : ""} title="preview"
          sandbox="allow-scripts allow-forms allow-modals allow-downloads"
          src="/preview-test/page.html" style="width:600px;height:300px"></iframe>
        <script>
          window.got = []; window.msgs = []; window.hostKeys = 0;
          window.addEventListener("keydown", () => { window.hostKeys += 1; });
          window.addEventListener("message", (e) => {
            // Same checks as HtmlFrame: this frame's window, this nonce.
            if (e.source !== document.getElementById("f").contentWindow) return;
            const d = e.data;
            if (d && d.mcp === 1 && d.n === ${JSON.stringify(NONCE)}) { window.got.push(d.type); window.msgs.push(d); }
          });
        </script></body>`,
    }),
  );
  await page.goto("/preview-test/host.html");
  const frame = page.frameLocator("#f");
  await expect(frame.locator("#field")).toBeVisible();
  return frame;
}

const got = (page: Page) => page.evaluate(() => (window as unknown as { got: string[] }).got);
const msgs = (page: Page) =>
  page.evaluate(() => (window as unknown as { msgs: { type: string; url?: string }[] }).msgs);
const hostKeys = (page: Page) =>
  page.evaluate(() => (window as unknown as { hostKeys: number }).hostKeys);

test("the bootstrap announces itself to the host from a sandboxed frame", async ({ page }) => {
  await open(page);
  await expect.poll(() => got(page)).toContain("ready");
});

test("Escape inside the frame never reaches the host window; the bootstrap relays it", async ({ page }) => {
  const frame = await open(page);
  await frame.locator("#field").focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => got(page)).toContain("escape");
  // This is the gap: without the relay the host's own Escape handler never fires.
  expect(await hostKeys(page)).toBe(0);
});

test("a page that handles Escape itself does not also close the host", async ({ page }) => {
  const frame = await open(page, {
    pageScript: `addEventListener("keydown", (e) => { if (e.key === "Escape") e.preventDefault(); });`,
  });
  await frame.locator("#field").focus();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await got(page)).not.toContain("escape");
});

test("outside a MonoCode frame (no channel name) the bootstrap stays silent", async ({ page }) => {
  await open(page, { name: "" });
  await page.waitForTimeout(300);
  expect(await got(page)).toEqual([]);
});

test("clicking an https link asks the host to open it and does not navigate the frame", async ({ page }) => {
  const frame = await open(page);
  await frame.locator("#ext").click();
  await expect.poll(async () => (await msgs(page)).find((m) => m.type === "open")?.url).toBe(
    "https://example.com/x?y=1",
  );
  await expect(frame.locator("#external")).toHaveCount(0);
  await expect(frame.locator("#field")).toBeVisible();
});

test("a modifier-click on an external link is routed to the host too", async ({ page }) => {
  const frame = await open(page);
  await frame.locator("#ext").click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await msgs(page)).some((m) => m.type === "open")).toBe(true);
});

test("a link to another page of the preview navigates inside the frame", async ({ page }) => {
  const frame = await open(page);
  await frame.locator("#rel").click();
  await expect(frame.locator("#second")).toBeVisible();
  expect((await msgs(page)).some((m) => m.type === "open")).toBe(false);
  // The next page is a fresh document, and the channel still works there.
  await expect.poll(async () => (await msgs(page)).filter((m) => m.type === "ready").length).toBe(2);
});

test("a page whose own script handles the click is left alone", async ({ page }) => {
  const frame = await open(page, {
    pageScript: `document.addEventListener("click", (e) => { if (e.target.closest("a")) e.preventDefault(); });`,
  });
  await frame.locator("#ext").click();
  await page.waitForTimeout(300);
  expect((await msgs(page)).some((m) => m.type === "open")).toBe(false);
  await expect(frame.locator("#external")).toHaveCount(0);
});
