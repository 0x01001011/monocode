import { describe, expect, it } from "vitest";
import { htmlWarnings } from "./htmlPreview";

describe("htmlWarnings", () => {
  it("is silent for a self-contained page", () => {
    const page = `<!doctype html><html><head><title>x</title>
      <link rel="stylesheet" href="https://cdn.example.com/a.css">
      <style>h1{color:red}</style></head>
      <body><img src="data:image/png;base64,AAAA"><a href="#top">top</a>
      <a href="about.html">about</a>
      <script src="https://cdn.example.com/chart.js"></script>
      <script>const t = '<img src="not-a-real-tag.png">';</script></body></html>`;
    expect(htmlWarnings(page)).toEqual([]);
  });

  it("flags relative resources an artifact cannot serve", () => {
    const warnings = htmlWarnings(
      `<link rel="stylesheet" href="style.css"><script src="./app.js"></script><img src='img/logo.png'>`,
    );
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("style.css");
    expect(warnings.join("\n")).toContain("app.js");
    expect(warnings.join("\n")).toContain("img/logo.png");
    for (const warning of warnings) expect(warning).toMatch(/single file/i);
  });

  it("flags root-relative paths, which also resolve nowhere", () => {
    expect(htmlWarnings(`<script src="/assets/app.js"></script>`)[0]).toContain(
      "/assets/app.js",
    );
  });

  it("flags plain http resources, which the preview blocks", () => {
    const warnings = htmlWarnings(
      `<script src="http://cdn.example.com/lib.js"></script>`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/https/i);
  });

  it("ignores references inside comments and script bodies, and repeats", () => {
    expect(
      htmlWarnings(`<!-- <link href="old.css"> --><script>document.write('<script src="x.js">')</script>`),
    ).toEqual([]);
    expect(htmlWarnings(`<img src="a.png"><img src="a.png">`)).toHaveLength(1);
  });

  it("caps the list so a bulky page does not flood the tool result", () => {
    const many = Array.from({ length: 12 }, (_, i) => `<img src="i${i}.png">`).join("");
    const warnings = htmlWarnings(many);
    expect(warnings).toHaveLength(6);
    expect(warnings[5]).toMatch(/and 7 more/);
  });
});
