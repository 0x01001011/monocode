import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// The exact script the preview scheme injects, read from the Rust source.
function bootstrap(): string {
  const source = readFileSync("src-tauri/src/html_preview.rs", "utf8");
  const block = source.match(/const BOOTSTRAP: &str = concat!\(([\s\S]*?)\n\);/)?.[1];
  if (!block) throw new Error("BOOTSTRAP not found in html_preview.rs");
  // Comments may quote things; only the string literals are the script.
  const code = block
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
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
  page.evaluate(() => (window as unknown as { msgs: { type: string; url?: string; level?: string; text?: string }[] }).msgs);
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

const consoleLines = async (page: Page) =>
  (await msgs(page)).filter((m) => m.type === "console");

test("console output, uncaught errors and rejections reach the host with their level", async ({ page }) => {
  const seen: string[] = [];
  page.on("console", (m) => seen.push(m.text()));
  await open(page, {
    pageScript: `
      console.log("hello", { a: 1 });
      console.warn("careful");
      console.error(new Error("boom"));
      setTimeout(() => { throw new TypeError("late failure"); }, 0);
      Promise.reject(new Error("nope"));`,
  });
  await expect.poll(async () => (await consoleLines(page)).length).toBeGreaterThanOrEqual(5);
  const lines = await consoleLines(page);
  expect(lines.find((m) => m.level === "log")?.text).toBe('hello {"a":1}');
  expect(lines.find((m) => m.level === "warn")?.text).toBe("careful");
  const errors = lines.filter((m) => m.level === "error").map((m) => m.text ?? "");
  expect(errors.some((t) => t.includes("boom"))).toBe(true);
  // Chromium reports the message; WebKit hides it for sandboxed pages and we
  // say so rather than leave a bare "Script error.".
  expect(
    errors.some((t) => t.includes("late failure") || /Script error\..*hides the details/.test(t)),
  ).toBe(true);
  expect(errors.some((t) => t.includes("Unhandled rejection") && t.includes("nope"))).toBe(true);
  // The page's own console keeps working.
  expect(seen.some((t) => t.includes("hello"))).toBe(true);
});

test("a console flood is capped on the page side", async ({ page }) => {
  await open(page, { pageScript: `for (let i = 0; i < 1000; i++) console.log("line " + i);` });
  await expect.poll(async () => (await consoleLines(page)).length).toBeGreaterThanOrEqual(300);
  await page.waitForTimeout(400);
  const lines = await consoleLines(page);
  expect(lines.length).toBeLessThanOrEqual(302);
  expect(lines[lines.length - 1].text).toMatch(/truncated/i);
});

test("a console call that cannot be serialized does not break the page", async ({ page }) => {
  await open(page, {
    pageScript: `const o = {}; o.self = o; console.log(o); console.log("after");`,
  });
  await expect.poll(async () => (await consoleLines(page)).some((m) => m.text === "after")).toBe(true);
});

test("a reloaded page returns to where the previous one was scrolled", async ({ page }) => {
  await page.route("**/preview-test/tall.html*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head>${bootstrap()}</head><body style="margin:0">
        <div id="end" style="height:4000px">tall page</div></body></html>`,
    }),
  );
  await page.route("**/preview-test/scroll-host.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body>
        <iframe id="a" name="${NONCE}" sandbox="allow-scripts" src="/preview-test/tall.html"
          style="width:500px;height:300px"></iframe>
        <script>
          // The host's side of the protocol, as HtmlFrame does it.
          let scroll = null; let readyBy = new Map(); window.restored = 0;
          addEventListener("message", (e) => {
            const d = e.data;
            if (!d || d.mcp !== 1 || d.n !== ${JSON.stringify(NONCE)}) return;
            if (d.type === "scroll" && e.source === document.getElementById("a").contentWindow) scroll = { x: d.x, y: d.y };
            if (d.type === "ready") {
              const count = (readyBy.get(e.source) || 0) + 1; readyBy.set(e.source, count);
              if (e.source !== document.getElementById("a").contentWindow && scroll && scroll.y > 0) {
                e.source.postMessage({ mcp: 1, n: ${JSON.stringify(NONCE)}, type: "restore", x: scroll.x, y: scroll.y }, "*");
                window.restored += 1;
              }
            }
          });
          window.reload = () => {
            const b = document.createElement("iframe");
            b.id = "b"; b.name = ${JSON.stringify(NONCE)}; b.setAttribute("sandbox", "allow-scripts");
            b.style.cssText = "width:500px;height:300px"; b.src = "/preview-test/tall.html?2";
            document.body.append(b);
          };
        </script></body>`,
    }),
  );
  await page.goto("/preview-test/scroll-host.html");
  const first = page.frameLocator("#a");
  await expect(first.locator("#end")).toBeVisible();
  await first.locator("#end").evaluate(() => window.scrollTo(0, 1500));
  // The page reports its position shortly after scrolling stops.
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as unknown as { reload: () => void }).reload());
  const second = page.frameLocator("#b");
  await expect(second.locator("#end")).toBeVisible();
  await expect
    .poll(() => second.locator("#end").evaluate(() => Math.round(window.scrollY)))
    .toBe(1500);
  expect(await page.evaluate(() => (window as unknown as { restored: number }).restored)).toBe(1);
});

test("navigator.clipboard.writeText in a page reaches the host instead of failing", async ({ page }) => {
  const frame = await open(page, {
    pageScript: `
      document.getElementById("field").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText("copied text"); document.title = "ok"; }
        catch (e) { document.title = "failed:" + e.name; }
      });`,
  });
  await frame.locator("#field").click();
  await expect.poll(async () => (await msgs(page)).find((m) => m.type === "copy")?.text).toBe("copied text");
  // The page's own promise resolved, so its UI can say 'Copied'.
  await expect.poll(() => frame.locator("body").evaluate(() => document.title)).toBe("ok");
});
