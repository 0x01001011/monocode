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
        <input id="field" aria-label="field"><script>${pageScript}</script></body></html>`,
    }),
  );
  await page.route("**/preview-test/host.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body>
        <iframe id="f" ${name ? `name="${name}"` : ""} title="preview"
          sandbox="allow-scripts allow-forms allow-modals allow-downloads"
          src="/preview-test/page.html" style="width:600px;height:300px"></iframe>
        <script>
          window.got = []; window.hostKeys = 0;
          window.addEventListener("keydown", () => { window.hostKeys += 1; });
          window.addEventListener("message", (e) => {
            // Same checks as HtmlFrame: this frame's window, this nonce.
            if (e.source !== document.getElementById("f").contentWindow) return;
            const d = e.data;
            if (d && d.mcp === 1 && d.n === ${JSON.stringify(NONCE)}) window.got.push(d.type);
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
