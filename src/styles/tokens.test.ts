import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contrast is computed from the values declared in index.css, so a token edit
 * that drops text below WCAG AA (4.5:1) or a focus ring below 3:1 fails here.
 * The grounds are the greys the theme produces: `--theme-dark-lightness`
 * 0-30% for dark, 97% for light. Ink is 92% / 18%.
 */
const css = readFileSync(
  resolve(process.cwd(), "src/styles/index.css"),
  "utf8",
);

type Rgb = [number, number, number];

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const grey = (percent: number): Rgb => {
  const v = (percent / 100) * 255;
  return [v, v, v];
};
/** `ink` at `alpha` over `ground`. */
const over = (ink: Rgb, ground: Rgb, alpha: number): Rgb => [
  ink[0] * alpha + ground[0] * (1 - alpha),
  ink[1] * alpha + ground[1] * (1 - alpha),
  ink[2] * alpha + ground[2] * (1 - alpha),
];
const hex = (value: string): Rgb => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];
const hsl = (h: number, s: number, l: number): Rgb => {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
};
const oklch = (l: number, c: number, h: number): Rgb => {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const enc = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  };
  return [enc(lin[0]), enc(lin[1]), enc(lin[2])];
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf("\n}", start));
}
function declared(scope: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(scope);
  if (!match) throw new Error(`${name} is not declared`);
  return match[1].replace(/\s+/g, " ").trim();
}

const root = block(":root");
const light = block("html.theme-light");
const theme = css.slice(
  css.indexOf("@theme {"),
  css.indexOf("\n}", css.indexOf("@theme {")),
);

// `clamp(60%, calc(60% + (var(--theme-dark-lightness) - 9%) * 1.5), 100%)`
const mutedRule =
  /clamp\(\s*(\d+)%,\s*calc\(\s*(\d+)% \+ \(var\(--theme-dark-lightness\) - 9%\) \* ([\d.]+)\),\s*(\d+)%\s*\)/.exec(
    declared(root, "--muted-strength"),
  );
// `clamp(0%, calc((var(--theme-dark-lightness) - 9%) * 2.5), 60%)`
const liftRule =
  /clamp\(\s*(\d+)%,\s*calc\(\(var\(--theme-dark-lightness\) - 9%\) \* ([\d.]+)\),\s*(\d+)%\s*\)/.exec(
    declared(root, "--status-lift"),
  );

const darkInk = grey(92);
const lightInk = grey(18);
const lightGround = grey(97);
const darkGrounds = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30];

const mutedStrength = (lightness: number) =>
  clamp(
    Number(mutedRule![2]) + (lightness - 9) * Number(mutedRule![3]),
    Number(mutedRule![1]),
    Number(mutedRule![4]),
  ) / 100;
const statusLift = (lightness: number) =>
  clamp(
    (lightness - 9) * Number(liftRule![2]),
    Number(liftRule![1]),
    Number(liftRule![3]),
  ) / 100;
const lighten = (color: Rgb, amount: number): Rgb =>
  over([255, 255, 255], color, amount);

describe("token formulas", () => {
  it("parses the slider-driven strengths", () => {
    expect(mutedRule).not.toBeNull();
    expect(liftRule).not.toBeNull();
  });
});

describe("--color-muted", () => {
  it.each(darkGrounds)(
    "is at least 4.5:1 on the dark ground at %i% lightness",
    (lightness) => {
      const ground = grey(lightness);
      const text = over(darkInk, ground, mutedStrength(lightness));
      expect(ratio(text, ground)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("stays readable on a selected row in the default dark theme", () => {
    const ground = grey(9);
    const selected = over(darkInk, ground, 0.1);
    const text = over(darkInk, selected, mutedStrength(9));
    expect(ratio(text, selected)).toBeGreaterThanOrEqual(4.5);
  });

  it("is at least 4.5:1 on the light ground and on a hovered row", () => {
    const strength =
      Number(/(\d+)%/.exec(declared(light, "--muted-strength"))![1]) / 100;
    const text = over(lightInk, lightGround, strength);
    expect(ratio(text, lightGround)).toBeGreaterThanOrEqual(4.5);
    const hovered = over(lightInk, lightGround, 0.1);
    expect(
      ratio(over(lightInk, hovered, strength), hovered),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("reaches `--color-muted` through the strength variable", () => {
    expect(declared(theme, "--color-muted")).toBe(
      "color-mix( in srgb, var(--color-content) var(--muted-strength), transparent )",
    );
  });

  it("keeps `--color-faint` weaker than `--color-muted` in both themes", () => {
    expect(Number.parseFloat(declared(root, "--faint-strength"))).toBeLessThan(
      Number(mutedRule![1]),
    );
    expect(Number.parseFloat(declared(light, "--faint-strength"))).toBeLessThan(
      Number.parseFloat(declared(light, "--muted-strength")),
    );
  });
});

describe("status colors", () => {
  const dark = {
    "--color-danger": oklch(0.704, 0.191, 22.216),
    "--color-warning": oklch(0.828, 0.189, 84.429),
    "--color-success": oklch(0.765, 0.177, 163.223),
  };

  it("keeps red-400, amber-400 and emerald-400 as the dark base", () => {
    expect(
      Object.fromEntries(
        Object.keys(dark).map((name) => [
          name,
          /oklch\([^)]*\)/.exec(declared(theme, name))?.[0],
        ]),
      ),
    ).toEqual({
      "--color-danger": "oklch(70.4% 0.191 22.216)",
      "--color-warning": "oklch(82.8% 0.189 84.429)",
      "--color-success": "oklch(76.5% 0.177 163.223)",
    });
  });

  it.each(Object.entries(dark))(
    "%s is at least 4.5:1 on every dark ground",
    (_name, color) => {
      for (const lightness of darkGrounds) {
        const text = lighten(color, statusLift(lightness));
        expect(ratio(text, grey(lightness))).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(["--color-danger", "--color-warning", "--color-success"])(
    "%s is at least 4.5:1 on the light ground and on a selected row",
    (name) => {
      const color = hex(declared(light, name));
      expect(ratio(color, lightGround)).toBeGreaterThanOrEqual(4.5);
      const selected = over(lightInk, lightGround, 0.06);
      expect(ratio(color, selected)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("reads `danger/10` as a legible destructive hover on light", () => {
    const danger = hex(declared(light, "--color-danger"));
    const fill = over(danger, lightGround, 0.1);
    expect(ratio(danger, fill)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("focus and accent", () => {
  const accent = hsl(211, 92, 62);

  it("uses a focus color with at least 3:1 against every ground", () => {
    const base =
      /color-mix\(\s*in srgb,\s*hsl\((\d+) (\d+)% (\d+)%\) calc\(100% - var\(--status-lift\)\),\s*white\s*\)/.exec(
        declared(theme, "--color-focus"),
      )!;
    const darkFocus = hsl(Number(base[1]), Number(base[2]), Number(base[3]));
    for (const lightness of darkGrounds) {
      const ring = lighten(darkFocus, statusLift(lightness));
      expect(ratio(ring, grey(lightness))).toBeGreaterThanOrEqual(3);
    }
    const lt = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(
      declared(light, "--color-focus"),
    )!;
    const lightFocus = hsl(Number(lt[1]), Number(lt[2]), Number(lt[3]));
    expect(ratio(lightFocus, lightGround)).toBeGreaterThanOrEqual(4.5);
    // The reason the token exists: raw accent is too faint on the light ground.
    expect(ratio(accent, lightGround)).toBeLessThan(3);
  });

  it("puts readable text on an accent fill", () => {
    const foreground = hex(declared(theme, "--color-accent-foreground"));
    expect(ratio(foreground, accent)).toBeGreaterThanOrEqual(4.5);
    expect(ratio([255, 255, 255], accent)).toBeLessThan(4.5);
  });
});

describe("index.css structure", () => {
  it("keeps every pre-existing color and motion token", () => {
    for (const name of [
      "--color-background-base",
      "--color-content",
      "--color-stroke",
      "--color-selection-subtle",
      "--color-selection",
      "--color-selection-strong",
      "--color-selection-hover",
      "--color-selection-emphasis",
      "--color-accent",
      "--color-skill",
      "--color-mention",
      "--color-diff-add",
      "--color-diff-add-fg",
      "--color-diff-del",
      "--color-diff-del-fg",
      "--leading-label",
    ]) {
      expect(theme).toContain(`${name}:`);
    }
    for (const name of [
      "--motion-reorder-duration",
      "--motion-tab-close-duration",
      "--motion-feedback-duration",
      "--motion-ease-out",
      "--motion-tab-ease-out",
    ]) {
      expect(root).toContain(`${name}:`);
    }
  });

  it("declares the semantic type scale with a floor of 10px", () => {
    const sizes = Object.fromEntries(
      ["micro", "label", "ui", "body", "title", "page"].map((name) => [
        name,
        Number.parseFloat(declared(theme, `--text-${name}`)),
      ]),
    );
    expect(sizes).toEqual({
      micro: 10,
      label: 11,
      ui: 12,
      body: 13,
      title: 15,
      page: 20,
    });
    for (const name of Object.keys(sizes)) {
      expect(
        Number(declared(theme, `--text-${name}--line-height`)),
      ).toBeGreaterThan(1);
    }
  });

  it("gives unstyled controls a base focus ring and a forced-colors outline", () => {
    expect(css).toMatch(
      /@layer base \{\s*:focus-visible \{\s*outline: 2px solid var\(--color-focus\);/,
    );
    expect(css).toMatch(/@utility focus-ring \{/);
    expect(css).toMatch(/@utility focus-ring-inset \{/);
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*:focus-visible \{\s*outline: 2px solid Highlight;/,
    );
    expect(
      block(".agent-markdown .markdown-code-copy:focus-visible"),
    ).toContain("outline: 2px solid var(--color-focus)");
  });

  it("stops every always-on loop under prefers-reduced-motion", () => {
    const start = css.indexOf("Always-on loops stop");
    const reduce = css.slice(
      start,
      css.indexOf("\n}\n\n.mascot-stunned", start),
    );
    for (const selector of [
      ".shimmer-text",
      ".mascot-active",
      ".mascot-rest",
      ".mascot-talk",
      ".composer-coin-face",
      ".composer-coin-edge",
      ".animate-pulse",
    ]) {
      expect(reduce).toContain(selector);
    }
    expect(reduce).toMatch(/animation: none/);
    // The shimmer's resting color is the muted token, not a raw alpha.
    expect(block(".shimmer-text")).toContain(
      "linear-gradient(var(--color-muted)",
    );
    expect(reduce).toMatch(/\.shimmer-text \{[^}]*color: var\(--color-muted\)/);
  });

  it("points placeholder text at the muted token", () => {
    expect(block(".composer-field::placeholder")).toContain(
      "var(--color-muted)",
    );
    expect(block(".markdown-source-field::placeholder")).toContain(
      "var(--color-muted)",
    );
  });

  it("lets diagnostic text be selectable", () => {
    const selectors = [...css.matchAll(/([^{}]+)\{\s*user-select: text;\s*\}/g)]
      .map((match) => match[1])
      .join(",");
    for (const selector of [
      '[role="alert"]',
      "[data-selectable]",
      "code",
      "kbd",
      ".break-all",
    ]) {
      expect(selectors).toContain(selector);
    }
  });

  it("shares one press response and a hit-area utility", () => {
    expect(css).toMatch(
      /@utility press-feedback \{[\s\S]*?scale: var\(--motion-press-scale\)/,
    );
    expect(css).toMatch(
      /\.primary-action:not\(:disabled\):active \{\s*scale: var\(--motion-press-scale\)/,
    );
    expect(css).toMatch(
      /@utility hit-area \{[\s\S]*?inset: calc\(var\(--hit-area-extend, 2px\) \* -1\)/,
    );
  });

  it("never transitions `all`", () => {
    expect(css).not.toMatch(/transition(?:-property)?:\s*all\b/);
    expect(css).not.toContain("transition-all");
  });
});
