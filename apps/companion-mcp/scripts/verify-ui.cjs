// Optional browser QA. Install Playwright separately, or set PLAYWRIGHT_MODULE.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
(async () => {
  const cwd = path.resolve(__dirname, "..");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "companion-ui-"));
  const output =
    process.env.COMPANION_QA_OUTPUT || path.join(cwd, "docs/screenshots");
  fs.mkdirSync(output, { recursive: true });
  const server = spawn(process.execPath, ["dist/server.js"], {
    cwd,
    env: {
      ...process.env,
      COMPANION_PORT: "4589",
      COMPANION_PUBLIC_URL: "http://127.0.0.1:4589",
      COMPANION_DATA_DIR: data,
      COMPANION_TOKEN: "ui-test-secret",
      COMPANION_GENERATION_ENABLED: "false",
      NOVELAI_API_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.once("data", resolve);
    server.once("exit", () => reject(new Error("Server exited before ready")));
  });
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_PATH
        ? {
            executablePath: process.env.CHROMIUM_PATH,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
          }
        : {}),
    });
    const page = await browser.newPage({
      viewport: { width: 1360, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:4589/admin");
    await page.locator("#login").waitFor({ state: "visible" });
    await page.locator("#token").fill("ui-test-secret");
    await page.locator("#connect").click();
    await page.locator("#editor").waitFor({ state: "visible" });
    const frame = page.frameLocator("#preview");
    await frame.locator(".name").filter({ hasText: "爱丽丝" }).waitFor();
    // A font override only for minimal Linux containers without CJK fonts; not shipped to the app.
    if (process.env.COMPANION_QA_FONT) {
      const bytes = fs
        .readFileSync(process.env.COMPANION_QA_FONT)
        .toString("base64");
      const css = `@font-face{font-family:QAChinese;src:url(data:font/woff2;base64,${bytes}) format('woff2')} :root{font-family:QAChinese,system-ui,sans-serif}`;
      await page.addStyleTag({ content: css });
      await page.frames()[1].addStyleTag({ content: css });
      await page.evaluate(() => document.fonts.ready);
      await page.frames()[1].evaluate(() => document.fonts.ready);
    }
    for (const [name, scheme, width, height] of [
      ["settings-light", "light", 1360, 1000],
      ["settings-dark", "dark", 1360, 1000],
      ["settings-mobile", "light", 390, 844],
    ]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(120);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "No horizontal overflow",
      );
      await page.screenshot({
        path: path.join(output, `${name}.png`),
        fullPage: true,
      });
    }
    await page.locator("#line").fill("保存测试：我们接着聊。");
    await page.locator("#save").click();
    await page.locator("#status").filter({ hasText: "已保存" }).waitFor();
    assert.equal(
      await frame.locator(".line").textContent(),
      "保存测试：我们接着聊。",
    );
    await page
      .locator("#portrait")
      .setInputFiles({
        name: "fixture.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    await page.locator("#status").filter({ hasText: "素材已上传" }).waitFor();
    await page.locator("#save").click();
    await frame.locator(".portrait").waitFor({ state: "visible" });
    assert.ok(
      await frame
        .locator(".portrait")
        .evaluate((img) => img.complete && img.naturalWidth === 1),
    );
    const rendered = await page.evaluate(async () => {
      const config = await fetch("/api/config", {
        headers: { Authorization: "Bearer ui-test-secret" },
      }).then((r) => r.json());
      const c = config.characters[0];
      return fetch("/api/preview", {
        method: "POST",
        headers: {
          Authorization: "Bearer ui-test-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          characterId: c.id,
          expression: "neutral",
          sceneId: c.defaultScene,
          outfit: c.defaultOutfit,
          line: "重复渲染测试",
          action: "",
          composition: "",
        }),
      }).then((r) => r.json());
    });
    const original = await frame.locator(".portrait").elementHandle();
    await page.evaluate((data) => {
      const f = document.querySelector("#preview");
      for (let i = 0; i < 3; i++)
        f.contentWindow.postMessage(
          { type: "companion-local-preview", result: data },
          location.origin,
        );
    }, rendered);
    await frame.locator(".line").filter({ hasText: "重复渲染测试" }).waitFor();
    assert.ok(
      await original.evaluate(
        (el) => el === document.querySelector(".portrait"),
      ),
      "Portrait DOM is preserved",
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        screenshots: output,
        checks: [
          "light/dark/mobile",
          "no overflow",
          "login",
          "save",
          "upload",
          "image load",
          "stable portrait DOM",
          "no page errors",
        ],
      }),
    );
  } finally {
    await browser?.close();
    server.kill();
    await new Promise((r) => server.once("exit", r));
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
