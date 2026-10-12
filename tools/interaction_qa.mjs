import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const usRoot = path.resolve(root, "../richChecker-us-kit");
const require = createRequire(path.join(os.homedir(), ".local/lib/node_modules/hyperframes/package.json"));
const helper = await fs.readFile(path.join(root, "js/faceMotion.js"), "utf8");
assert.equal(helper, await fs.readFile(path.join(usRoot, "js/faceMotion.js"), "utf8"));
const { createFaceGeometry } = await import("data:text/javascript;base64," + Buffer.from(helper).toString("base64"));
const unitPoints = Array.from({ length: 478 }, (_, i) => ({ x: i / 478, y: 1 - i / 478 }));
const unitGeometry = createFaceGeometry(unitPoints, 1200, 800);
assert.equal(unitGeometry.points.length, 14);
assert.equal(unitGeometry.contours.length, 5);
assert.equal(unitGeometry.measurements.length, 6);
assert.equal(unitGeometry.measurements[5].length, 2);
assert.deepEqual(unitGeometry.points[0].position, [unitPoints[10].x * 1200, unitPoints[10].y * 800]);
assert.equal(createFaceGeometry([], 100, 100), null);
assert.equal(createFaceGeometry(unitPoints, 0, 100), null);
const browser = await require("puppeteer-core").launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const reports = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  for (const [edition, port] of [["kr", 18877], ["us", 18878]]) {
    const page = await browser.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on("request", request => {
      requests.push({ url: request.url(), method: request.method() });
      /googletagmanager|google-analytics|googlesyndication|doubleclick/.test(request.url()) ? request.abort() : request.continue();
    });
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${port}/?flow=1`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => { await startCoreWarmup("qa"); return true; });
    await page.evaluate(() => {
      window.qa = { geometry: [], stages: [], events: [], native: [], clipboard: [] };
      const track = trackEvent;
      trackEvent = (name, params) => { qa.events.push({ name, ...params }); track(name, params); };
      const stage = setLoadingStage;
      setLoadingStage = (...args) => { qa.stages.push({ stage: args[0], at: performance.now() }); stage(...args); };
      const detect = faceLandmarkerInstance.detect.bind(faceLandmarkerInstance);
      faceLandmarkerInstance.detect = canvas => {
        const result = detect(canvas);
        window.qaLandmarks = result.faceLandmarks?.[0];
        return result;
      };
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || !node.matches?.(".face-motion")) continue;
          const box = node.viewBox.baseVal;
          const points = [...node.querySelectorAll("circle")].map(point => ({
            index: Number(point.dataset.landmark), x: Number(point.getAttribute("cx")), y: Number(point.getAttribute("cy")),
          }));
          qa.geometry.push({
            target: node.parentElement.id || "result-photo", width: box.width, height: box.height,
            preserve: node.getAttribute("preserveAspectRatio"), points,
            measures: node.querySelectorAll(".face-motion-measure").length,
            trueCoordinates: points.every(point => Math.abs(point.x - qaLandmarks[point.index].x * box.width) < 0.0001 && Math.abs(point.y - qaLandmarks[point.index].y * box.height) < 0.0001),
          });
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    async function upload(filename) {
      await (await page.$("#uploadImage")).uploadFile(filename);
      await page.waitForFunction(() => document.getElementById("loadingModal").style.display === "none" && Number(getComputedStyle(document.getElementById("resultsContainer")).opacity) > 0.9, { timeout: 60000 });
    }
    // Hold only the QA data await to inspect a real detected face at multiple sizes.
    await page.evaluate(() => {
      window.qaLoad = loadEmbeddings;
      loadEmbeddings = async () => { await new Promise(resolve => { window.qaRelease = resolve; }); return qaLoad(); };
    });
    await (await page.$("#uploadImage")).uploadFile(path.join(root, "tools/motion-preview/.media/images/image_001.png"));
    await page.waitForFunction(() => !!document.querySelector("#analysisGeometry .face-motion"), { timeout: 60000 });
    await delay(650);
    for (const width of [320, 390, 1440]) {
      await page.setViewport({ width, height: 844 });
      const bounds = await page.evaluate(() => {
        const modal = document.querySelector(".modal-content").getBoundingClientRect();
        const canvas = document.getElementById("analysisPhoto");
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        return { left: modal.left, right: modal.right, top: modal.top, bottom: modal.bottom, nonblank: data.some(value => value > 0) };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= 844 && bounds.nonblank, JSON.stringify(bounds));
      if (width !== 320) await page.screenshot({ path: `/tmp/rich-flow-${edition}-analysis-${width}.png` });
    }
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => { loadEmbeddings = qaLoad; qaRelease(); });
    await page.waitForFunction(() => !!document.querySelector("#topMatchPhotos .face-motion") && Number(getComputedStyle(document.getElementById("resultsContainer")).opacity) > 0.9);
    const firstOffset = await page.$eval("#topMatchPhotos .face-motion-contour", el => Number(getComputedStyle(el).strokeDashoffset.replace("px", "")));
    await delay(80);
    const nextOffset = await page.$eval("#topMatchPhotos .face-motion-contour", el => Number(getComputedStyle(el).strokeDashoffset.replace("px", "")));
    assert.ok(nextOffset < firstOffset, JSON.stringify({ firstOffset, nextOffset }));
    await page.screenshot({ path: `/tmp/rich-flow-${edition}-result-390.png`, fullPage: true });
    await page.waitForFunction(() => !document.querySelector("#topMatchPhotos .face-motion"));
    assert.equal(await page.$eval("#resultDetails", el => el.open), false);
    assert.equal(await page.$$eval("#resultDetails .reading-item", items => items.length), 6);
    const order = await page.evaluate(() => ["#topMatch", "#resultDetails", "#faceHideToggle", "#webShareBtn"].map(selector => document.querySelector(selector).getBoundingClientRect().top));
    assert.ok(order.every((top, i) => i === 0 || top > order[i - 1]), JSON.stringify(order));
    await page.click("#resultDetails > summary");
    await page.$eval("#resultDetails", el => el.scrollIntoView());
    await page.screenshot({ path: `/tmp/rich-flow-${edition}-details-390.png`, fullPage: true });
    const geometry = await page.evaluate(() => qa.geometry);
    assert.ok(geometry.length >= 2 && geometry.every(item => item.trueCoordinates && item.measures === 6 && item.points.length === 14), JSON.stringify(geometry));
    assert.ok(geometry.some(item => item.preserve === "xMidYMid meet") && geometry.some(item => item.preserve === "xMidYMid slice"));

    // Native share is simulated: no real recipients; verify the synchronous payload/telemetry contract.
    await page.evaluate(() => {
      cancelShareArtifactPreparation();
      preparedShareBlob = null;
      window.qaPrepare = prepareShareArtifact;
      prepareShareArtifact = async () => null;
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", { configurable: true, value: payload => {
        qa.native.push({ url: payload.url, text: payload.text, files: payload.files?.length || 0, active: navigator.userActivation.isActive });
        return qa.mode ? Promise.reject(new DOMException("QA outcome", qa.mode)) : Promise.resolve();
      } });
      qa.events = [];
    });
    await page.click("#webShareBtn");
    await page.waitForFunction(() => qa.events.some(e => e.name === "share_success"));
    let share = await page.evaluate(() => ({ native: qa.native.at(-1), events: qa.events }));
    assert.equal(share.native.files, 0);
    assert.equal(share.native.active, true);
    assert.ok(share.native.url.includes("via=share") && !share.native.url.includes("data:"));
    assert.equal(share.events.filter(e => e.name === "share_click").length, 1);
    await page.evaluate(() => { qa.events = []; preparedShareBlob = new Blob(["QA file payload"], { type: "image/png" }); });
    await page.click("#webShareBtn");
    await page.waitForFunction(() => qa.events.some(e => e.name === "share_success"));
    assert.equal(await page.evaluate(() => qa.native.at(-1).files), 0);
    assert.ok(await page.evaluate(() => qa.native.at(-1).text.includes(qa.native.at(-1).url)));
    await page.evaluate(() => { qa.events = []; });
    await page.click("#instagramShareBtn");
    await page.waitForFunction(() => qa.events.some(e => e.name === "share_success"));
    assert.equal(await page.evaluate(() => qa.native.at(-1).files), 1);
    for (const [mode, outcome] of [["AbortError", "share_cancel"], ["NotAllowedError", "share_error"]]) {
      await page.evaluate(mode => { qa.events = []; qa.mode = mode; }, mode);
      await page.click("#webShareBtn");
      await page.waitForFunction(outcome => qa.events.some(e => e.name === outcome), {}, outcome);
      assert.equal(await page.evaluate(() => qa.events.some(e => e.name === "share_success")), false);
    }
    assert.equal(await page.$eval("#shareLinkFallback", el => el.hidden), false);
    await page.click("#shareLinkClose");
    await page.evaluate(() => {
      qa.events = []; qa.mode = null; preparedShareBlob = null;
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: text => { qa.clipboard.push(text); return Promise.resolve(); } } });
    });
    await page.click("#instagramShareBtn");
    await page.waitForFunction(() => qa.events.some(e => e.name === "share_success" && e.transport === "clipboard"));
    assert.ok(await page.evaluate(() => qa.clipboard.at(-1).includes("via=share")));
    await page.evaluate(() => { qa.events = []; navigator.clipboard.writeText = () => Promise.reject(new Error("QA denied")); });
    await page.click("#webShareBtn");
    await page.waitForFunction(() => qa.events.some(e => e.name === "share_error"));
    assert.equal(await page.$eval("#shareLinkFallback", el => el.hidden), false);
    await page.evaluate(() => { prepareShareArtifact = qaPrepare; });
    await page.click("#reset");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("introSection")).display !== "none");
    assert.equal(await page.$eval("#shareLinkFallback", el => el.hidden), true);

    // Unmodified, warm processing: second identity must generate different real geometry.
    const secondPortrait = path.join(usRoot, "assets/people/caricature-sheet/008-jensen-huang.png");
    await page.evaluate(() => { qa.stages = []; });
    await upload(secondPortrait);
    const second = await page.evaluate(() => qa.geometry.filter(item => item.target === "analysisGeometry").at(-1));
    assert.notDeepEqual(second.points, geometry[0].points);
    const warmStages = await page.evaluate(() => qa.stages);
    assert.deepEqual(warmStages.map(item => item.stage), [0, 1, 2, 3]);
    await page.evaluate(() => document.getElementById("faceHideToggle").click());
    assert.equal(await page.$("#topMatchPhotos .face-motion"), null);
    await page.evaluate(async () => {
      const canvas = await captureShareCard();
      qa.capture = { width: canvas.width, height: canvas.height, overlays: document.querySelectorAll("#shareCard .face-motion").length, privacy: getComputedStyle(document.querySelector("#shareCard .face-hidden-overlay")).display };
    });
    const capture = await page.evaluate(() => qa.capture);
    assert.ok(capture.width >= 800 && capture.height > 0 && capture.overlays === 0 && capture.privacy === "flex");
    await page.click("#reset");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("introSection")).display !== "none");
    await page.evaluate(() => { faceHidden = false; applyFaceHiddenState(); });
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await upload(secondPortrait);
    assert.equal(await page.$eval("#topMatchPhotos .face-motion-contour", el => getComputedStyle(el).strokeDasharray), "none");
    const projection = await page.evaluate(() => {
      const svg = document.querySelector("#topMatchPhotos .face-motion");
      const rect = svg.getBoundingClientRect();
      const image = svg.parentElement.querySelector("img");
      const width = image.naturalWidth, height = image.naturalHeight;
      const scale = Math.max(rect.width / width, rect.height / height);
      return [...svg.querySelectorAll("circle")].map(circle => {
        const index = Number(circle.dataset.landmark);
        const point = new DOMPoint(Number(circle.getAttribute("cx")), Number(circle.getAttribute("cy"))).matrixTransform(svg.getScreenCTM());
        const expectedX = rect.left + rect.width / 2 + (qaLandmarks[index].x - 0.5) * width * scale;
        const expectedY = rect.top + rect.height / 2 + (qaLandmarks[index].y - 0.5) * height * scale;
        return Math.hypot(point.x - expectedX, point.y - expectedY);
      });
    });
    assert.ok(projection.every(error => error < 0.1), JSON.stringify(projection));
    await page.click("#reset");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("introSection")).display !== "none");
    await page.evaluate(async () => {
      const blank = document.createElement("canvas"); blank.width = blank.height = 200;
      blank.getContext("2d").fillRect(0, 0, 200, 200);
      const blob = await new Promise(resolve => blank.toBlob(resolve));
      const data = new DataTransfer(); data.items.add(new File([blob], "no-face.png", { type: "image/png" }));
      const input = document.getElementById("uploadImage"); input.files = data.files; input.dispatchEvent(new Event("change"));
    });
    try {
      await page.waitForFunction(() => qa.events.some(e => e.name === "analysis_error" && e.error_type === "face_not_detected") && document.getElementById("loadingModal").style.display === "none");
    } catch (err) {
      console.error("NO-FACE DIAGNOSTICS", edition, errors, await page.evaluate(() => ({ events: qa.events.slice(-12), modal: document.getElementById("loadingModal").style.cssText, status: document.getElementById("loadingStatus").textContent, result: document.getElementById("resultsContainer").style.cssText })));
      throw err;
    }
    assert.equal(await page.$$eval(".face-motion", items => items.length), 0);
    assert.equal(await page.$eval("#analysisPhoto", el => el.width), 0);
    assert.deepEqual(errors, []);
    assert.ok(!requests.some(request => request.method === "POST" || /age_gender/.test(request.url)));
    reports.push({ edition, geometry, second, warmStages, capture, errors, shareMatrix: "link, image+link, success, cancel, native error, clipboard, denied manual fallback", screenshots: "Analysis is held at real detected geometry only for QA screenshots; second portrait is normal unmodified processing." });
    console.log("PASS", edition, "real geometry, moving strokes, mobile/desktop, first-click sharing, all outcomes, repeated analysis, face privacy, reduced motion, no-face cleanup");
    await page.close();
  }
  await fs.writeFile("/tmp/rich-flow-evidence.json", JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
}
