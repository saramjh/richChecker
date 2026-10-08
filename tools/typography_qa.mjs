import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const usRoot = process.argv[2] || path.resolve(root, "../richChecker-us-kit");
const require = createRequire(path.join(os.homedir(), ".local/lib/node_modules/hyperframes/package.json"));
const browser = await require("puppeteer-core").launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const reports = [];
const widths = [320, 390, 768, 1440];
const seo = html => [...html.matchAll(/<title>[^<]*<\/title>|<meta\b[^>]*>|<link\b[^>]*rel="canonical"[^>]*>|<script type="application\/ld\+json">[\s\S]*?<\/script>/g)].map(m => m[0]);

try {
  for (const [edition, directory, port, baseline] of [["kr", root, 18877, "HEAD"], ["us", usRoot, 18878, "origin/main"]]) {
    const current = await fs.readFile(path.join(directory, "index.html"), "utf8");
    assert.deepEqual(seo(current), seo(execFileSync("git", ["show", baseline + ":index.html"], { cwd: directory, encoding: "utf8" })));
    for (const filename of ["data/embeddings.json", "js/faceFeatures.js", "js/matchMath.js", "robots.txt", "sitemap.xml"]) {
      assert.deepEqual(await fs.readFile(path.join(directory, filename)), execFileSync("git", ["show", baseline + ":" + filename], { cwd: directory }));
    }
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setRequestInterception(true);
    page.on("request", request => /googletagmanager|google-analytics|googlesyndication|doubleclick/.test(request.url()) ? request.abort() : request.continue());
    await page.goto(`http://127.0.0.1:${port}/?type=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.getElementById("bootOverlay"));
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const client = await page.createCDPSession();
    await client.send("DOM.enable");
    await client.send("CSS.enable");

    async function audit(state) {
      for (const width of widths) {
        await page.setViewport({ width, height: 1000 });
        const report = await page.evaluate(state => {
          const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0;
          const selectors = state === "entry" ? ["h1", ".tagline", ".value-prop", "#photoSlot", "#choosePhotoBtn", ".fine-print", "summary"] : ["h1", "#topMatchName", ".runner-up-copy", ".reading-item", "#archetypeDesc"];
          const overflow = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(visible).filter(el => el.scrollWidth > el.clientWidth + 2).map(el => ({ selector, text: el.textContent.trim(), scroll: el.scrollWidth, width: el.clientWidth })));
          return {
            state, width: innerWidth, pageWidth: document.documentElement.scrollWidth,
            overflow, heading: getComputedStyle(document.querySelector("h1")).fontFamily,
            body: getComputedStyle(document.body).fontFamily,
            tracking: getComputedStyle(document.querySelector("h1")).letterSpacing,
            privacyAlign: getComputedStyle(document.querySelector(".fine-print")).textAlign,
            readings: document.querySelectorAll("#resultsContainer #readingScroll .reading-item").length,
          };
        }, state);
        assert.ok(report.pageWidth <= width + 2, JSON.stringify(report));
        assert.deepEqual(report.overflow, [], JSON.stringify(report));
        assert.ok(report.heading.includes("Noto Serif KR"));
        assert.ok(report.body.includes("Pretendard"));
        assert.ok(["normal", "0px"].includes(report.tracking));
        assert.equal(report.privacyAlign, "left");
        const bottom = await page.evaluate(() => {
          const note = document.getElementById("privacyNote");
          const ad = document.getElementById("bottomAd");
          return {
            count: document.querySelectorAll(".adsbygoogle").length,
            outsideResults: !ad.closest("#resultsContainer"),
            afterPrivacy: ad.getBoundingClientRect().top > note.getBoundingClientRect().bottom,
            width: ad.querySelector("ins").getBoundingClientRect().width,
            privacyOverflow: note.scrollWidth > note.clientWidth + 1,
            lines: [...note.children].map(el => ({ height: el.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) })),
          };
        });
        assert.equal(bottom.count, 1);
        assert.ok(bottom.outsideResults && bottom.afterPrivacy && bottom.width > 0 && !bottom.privacyOverflow, JSON.stringify(bottom));
        if (edition === "kr") assert.ok(bottom.lines.length === 2 && bottom.lines.every(line => line.height <= line.lineHeight + 1), JSON.stringify(bottom));
        if (state === "result") assert.equal(report.readings, 6);
        if (state === "entry") {
          const entry = await page.evaluate(() => {
            const slot = document.getElementById("photoSlot").getBoundingClientRect();
            const cta = document.getElementById("choosePhotoBtn").getBoundingClientRect();
            return { slot: { width: slot.width, height: slot.height, bottom: slot.bottom }, ctaTop: cta.top, nestedButtons: document.querySelectorAll("#photoSlot button").length, emptyHidden: document.getElementById("uploadedImageContainer").hidden };
          });
          assert.ok(entry.slot.width > 0 && Math.abs(entry.slot.width / entry.slot.height - 5 / 3) < 0.01);
          assert.ok(entry.slot.bottom < entry.ctaTop);
          assert.equal(entry.nestedButtons, 0);
          assert.equal(entry.emptyHidden, true);
        }
        if (state === "result") {
          const prose = await page.evaluate(() => ({
            background: getComputedStyle(document.querySelector("#resultsContainer .reading-item p")).backgroundImage,
            align: getComputedStyle(document.querySelector("#archetypeDesc")).textAlign,
            matchBackground: getComputedStyle(document.querySelector(".feature-person")).backgroundColor,
          }));
          assert.equal(prose.background, "none");
          assert.equal(prose.align, "left");
          assert.equal(prose.matchBackground, "rgba(0, 0, 0, 0)");
        }
        reports.push({ edition, ...report });
        if ([390, 1440].includes(width)) await page.screenshot({ path: `/tmp/rich-type-${edition}-${state}-${width}.png`, fullPage: true });
      }
    }

    await audit("entry");
    console.log("PASS", edition, "entry widths and text bounds");
    const { root: documentNode } = await client.send("DOM.getDocument");
    for (const selector of ["h1", "#choosePhotoBtn span"]) {
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: documentNode.nodeId, selector });
      const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      assert.ok(fonts.length > 0 && fonts.every(font => font.isCustomFont), JSON.stringify({ selector, fonts }));
      reports.push({ edition, selector, fonts });
    }
    await page.click(".method-note summary");
    assert.equal(await page.$eval(".method-note", el => el.open), true);
    assert.ok(await page.$eval(".summary-icon", el => getComputedStyle(el).transform !== "none"));
    const pointerPicker = page.waitForFileChooser();
    await page.click("#photoSlot", { offset: { x: 12, y: 12 } });
    await (await pointerPicker).cancel();
    assert.equal(await page.$eval("#photoSlot", el => el.hidden), false);
    const keyboardPicker = page.waitForFileChooser();
    await page.focus("#photoSlot");
    await page.keyboard.press("Space");
    await (await keyboardPicker).accept([path.join(root, "tools/motion-preview/.media/images/image_001.png")]);
    try {
      await page.waitForFunction(() => document.querySelectorAll("#resultsContainer #readingScroll .reading-item").length === 6 && Number(getComputedStyle(document.getElementById("resultsContainer")).opacity) > 0.9, { timeout: 60000 });
    } catch (error) {
      console.error(edition, errors, await page.evaluate(() => ({ text: document.body.innerText.slice(-3000), readings: document.querySelectorAll(".reading-item").length, opacity: getComputedStyle(document.getElementById("resultsContainer")).opacity })));
      throw error;
    }
    await page.evaluate(() => document.fonts.ready.then(() => true));
    assert.equal(await page.$eval("#photoSlot", el => el.hidden), true);
    await page.click("#resultDetails > summary");
    assert.equal(await page.$eval("#resultDetails", el => el.open), true);
    await audit("result");
    assert.ok(await page.$eval("#resultDetails", el => !!(el.compareDocumentPosition(document.querySelector(".result-actions")) & Node.DOCUMENT_POSITION_FOLLOWING)));
    assert.equal(await page.$eval(".details-expand", el => getComputedStyle(el).display), "none");
    assert.notEqual(await page.$eval(".details-collapse", el => getComputedStyle(el).display), "none");
    await page.focus("#resultDetails > summary");
    await page.keyboard.press("Enter");
    assert.equal(await page.$eval("#resultDetails", el => el.open), false);
    assert.ok(await page.$eval("#resultPreview #archetypeDesc", el => el.getBoundingClientRect().height > 0 && el.textContent.trim().length > 0));
    assert.equal(await page.$$eval("#resultsContainer #archetypeBadge", els => els.length), 1);
    assert.ok(await page.$eval("#resultPreview .feature-person img", el => el.complete && el.naturalWidth > 0));
    assert.ok(await page.$eval("#resultPreview .feature-person-copy", el => el.querySelector("strong").textContent.trim() && el.querySelector("span").textContent.trim() && el.querySelector("p").textContent.trim()));
    assert.equal(await page.$eval("#resultPreview #archetypeBadge", el => getComputedStyle(el).backgroundImage), "none");
    assert.notEqual(await page.$eval(".details-expand", el => getComputedStyle(el).display), "none");
    assert.equal(await page.$eval(".details-collapse", el => getComputedStyle(el).display), "none");
    await page.screenshot({ path: `/tmp/rich-details-${edition}-closed.png`, fullPage: true });
    await page.keyboard.press("Space");
    assert.equal(await page.$eval("#resultDetails", el => el.open), true);
    await page.setViewport({ width: 390, height: 844 });
    await (await page.$("#resultsContainer #readingScroll")).screenshot({ path: `/tmp/rich-type-${edition}-readings.png` });
    const capture = await page.evaluate(async () => {
      const canvas = await captureShareCard();
      return { width: canvas.width, height: canvas.height, hidden: getComputedStyle(document.getElementById("shareCard")).display === "none" };
    });
    assert.ok(capture.width >= 800 && capture.height > 0 && capture.hidden);
    reports.push({ edition, capture });
    await page.click("#reset");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("introSection")).display !== "none");
    assert.equal(await page.$eval("#uploadedImageContainer", el => el.hidden), true);
    assert.equal(await page.$eval("#photoSlot", el => el.hidden), false);
    await page.close();
    console.log("PASS", edition, "self-hosted actual fonts, entry/result widths320/390/768/1440, six real readings, disclosure, share capture, reset and SEO parity");
  }
  await fs.writeFile("/tmp/rich-type-evidence.json", JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
}
