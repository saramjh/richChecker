import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(os.homedir(), ".local/lib/node_modules/hyperframes/package.json"));
const browser = await require("puppeteer-core").launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const base = process.env.RICHCHECKER_QA_URL || "http://127.0.0.1:18971/";
const fixtures = process.env.RICHCHECKER_QA_FIXTURES;
if (!fixtures) throw new Error("Set RICHCHECKER_QA_FIXTURES to the directory of real format samples");
const cases = [
  ["face.jpg", "jpeg", "processed"],
  ["face.png", "png", "processed"],
  ["face.webp", "webp", "processed"],
  ["face.avif", "avif", "processed"],
  ["face.gif", "gif", "processed"],
  ["face.bmp", "bmp", "processed"],
  ["face.tiff", "tiff", "image_decode"],
  ["face.heic", "heic", "image_decode"],
  ["corrupt.jpg", "jpeg", "image_decode"],
  ["empty.jpg", "jpeg", "empty_file"],
  ["vector.svg", "svg", "unsupported_type"],
];
const observations = [];
const blocked = [];
const errors = [];

async function setup() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const url = r.url();
    if (url.startsWith(base) || url.startsWith("blob:") || url.startsWith("data:")) return r.continue();
    blocked.push(url.split("?")[0]);
    return r.abort();
  });
  await page.setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36");
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.qa = { events: [], processed: 0, created: [], revoked: [] };
    trackEvent = (name, params = {}) => qa.events.push({ name, ...params });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      qa.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      qa.revoked.push(url);
      return revoke(url);
    };
    processImage = async (ctx, loadingId) => {
      qa.processed++;
      qa.events.push({ name: "analysis_started", ...ctx });
      qa.events.push({ name: "analysis_complete", ...ctx });
      await hideLoadingModal(loadingId);
    };
  });
  return page;
}

async function outcome(page) {
  await page.waitForFunction(() => qa.processed > 0 || qa.events.some(e => e.name === "upload_error"), { timeout: 15000 });
  return page.evaluate(() => ({
    processed: qa.processed,
    events: qa.events.filter(e => ["upload_started", "upload_error", "analysis_started", "analysis_complete"].includes(e.name)),
    loader: document.getElementById("loadingModal").style.display,
    toast: document.getElementById("toast").textContent,
    currentPhoto: document.getElementById("uploadedImage").src.startsWith("blob:"),
    created: qa.created.length,
    revoked: qa.revoked.length,
  }));
}

try {
  for (const [filename, format, expected] of cases) {
    const file = path.join(fixtures, filename);
    assert(fs.existsSync(file), "Missing test fixture: " + filename);
    const page = await setup();
    try {
      await (await page.$("#uploadImage")).uploadFile(file);
      const data = await outcome(page);
      const starts = data.events.filter(e => e.name === "upload_started");
      const failures = data.events.filter(e => e.name === "upload_error");
      assert.equal(starts.length, 1, filename + " should emit one start");
      assert.equal(starts[0].upload_format, format, filename + " format classification");
      assert.ok(starts[0].upload_size_band, filename + " size band");
      assert.equal(data.processed, expected === "processed" ? 1 : 0, filename + " processing");
      assert.equal(failures[0]?.error_type || "processed", expected, filename + " error classification");
      if (failures.length) assert.ok(["preflight", "decode", "object_url"].includes(failures[0].stage), filename + " stage");
      if (filename === "face.heic") assert.match(data.toast, /HEIC|JPG/, "HEIC specific recovery guidance");
      if (expected !== "processed") assert.equal(data.created, data.revoked, filename + " failure must not retain Blob");
      observations.push({ filename, format, result: expected, stage: failures[0]?.stage || "analysis" });
    } finally { await page.close(); }
  }

  const page = await setup();
  try {
    const fake = await page.evaluate(async () => {
      const stalled = { addEventListener() {}, removeEventListener() {}, set src(value) {} };
      try { await setImageSourceAndWait(stalled, "blob:no-load", 40); return null; }
      catch (err) { return err.code; }
    });
    assert.equal(fake, "IMAGE_TIMEOUT", "Stalled image provider must time out and clean up listeners");

    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.png"));
    await page.waitForFunction(() => qa.processed === 1);
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    await page.waitForFunction(() => qa.processed === 2);
    let life = await page.evaluate(() => ({ created: qa.created.length, revoked: qa.revoked.length, oldRevoked: qa.revoked.includes(qa.created[0]), newAlive: !qa.revoked.includes(qa.created[1]) }));
    assert.deepEqual(life, { created: 2, revoked: 1, oldRevoked: true, newAlive: true }, "Photo reselection must revoke prior Blob only");
    await page.evaluate(() => commitIntroState());
    life = await page.evaluate(() => ({ created: qa.created.length, revoked: qa.revoked.length }));
    assert.deepEqual(life, { created: 2, revoked: 2 }, "Reset must free remaining Blob");

    // Real File object, but categorization never transmits the provided name.
    await page.evaluate(async (base64) => {
      qa.events = []; qa.processed = 0;
      const bytes = Uint8Array.from(atob(base64), x => x.charCodeAt(0));
      const file = new File([bytes], "private-user-fullname-camera.jpg", { type: "image/jpeg" });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById("uploadImage");
      input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    }, fs.readFileSync(path.join(fixtures, "face.jpg")).toString("base64"));
    await page.waitForFunction(() => qa.processed === 1);
    const wire = await page.evaluate(() => JSON.stringify(qa.events));
    assert.ok(!wire.includes("private-user") && !wire.includes("blob:") && !wire.includes("data:image"), "Diagnostics must not include file names, URLs or photo bytes");
    observations.push({ filename: "repeat/reset/timeout/privacy", result: "pass" });
  } finally { await page.close(); }

  // Oversized data is rejected before Blob URL creation, not after memory-intensive decode.
  const largePage = await setup();
  try {
    await largePage.evaluate(() => {
      const huge = new File([new Uint8Array(51 * 1024 * 1024)], "huge.jpg", { type: "image/jpeg" });
      const dt = new DataTransfer(); dt.items.add(huge);
      const input = document.getElementById("uploadImage");
      input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const data = await outcome(largePage);
    assert.equal(data.events.find(e => e.name === "upload_error")?.error_type, "file_too_large");
    assert.equal(data.events.find(e => e.name === "upload_error")?.stage, "preflight");
    assert.equal(data.processed, 0);
    assert.equal(data.created, 0);
    observations.push({ filename: "oversized file preflight", result: "pass" });
  } finally { await largePage.close(); }

  // Decoded pixels may still be excessive even if compressed file size is small.
  const pixelPage = await setup();
  try {
    await pixelPage.evaluate(() => {
      setImageSourceAndWait = async (img, src) => {
        Object.defineProperty(img, "naturalWidth", { configurable: true, value: 12000 });
        Object.defineProperty(img, "naturalHeight", { configurable: true, value: 12000 });
        img.src = src;
      };
    });
    await (await pixelPage.$("#uploadImage")).uploadFile(path.join(fixtures, "face.png"));
    const data = await outcome(pixelPage);
    assert.equal(data.events.find(e => e.name === "upload_error")?.error_type, "too_many_pixels");
    assert.equal(data.processed, 0);
    assert.equal(data.created, data.revoked);
    observations.push({ filename: "pixel-budget safety", result: "pass" });
  } finally { await pixelPage.close(); }

  const timeoutPage = await setup();
  try {
    await timeoutPage.evaluate(() => {
      setImageSourceAndWait = async () => {
        const error = new Error("QA stalled provider"); error.code = "IMAGE_TIMEOUT"; throw error;
      };
    });
    await (await timeoutPage.$("#uploadImage")).uploadFile(path.join(fixtures, "face.png"));
    const data = await outcome(timeoutPage);
    assert.equal(data.events.find(e => e.name === "upload_error")?.error_type, "image_timeout");
    assert.equal(data.created, data.revoked);
    observations.push({ filename: "provider timeout recovery", result: "pass" });
  } finally { await timeoutPage.close(); }

  const objectPage = await setup();
  try {
    await objectPage.evaluate(() => {
      URL.createObjectURL = () => { throw new Error("QA file provider rejected"); };
    });
    await (await objectPage.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    const data = await outcome(objectPage);
    assert.equal(data.events.find(e => e.name === "upload_error")?.error_type, "object_url");
    assert.equal(data.created, data.revoked);
    observations.push({ filename: "object URL failure recovery", result: "pass" });
  } finally { await objectPage.close(); }

  // Android file providers can omit MIME types. Decode real bytes rather
  // than rejecting missing MIME or trusting a possibly misleading extension.
  for (const [label, type, expectedFormat] of [
    ["camera-capture", "", "unknown"],
    ["camera.jpg", "application/octet-stream", "jpeg"],
  ]) {
    const page = await setup();
    try {
      await page.evaluate(({ base64, label, type }) => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const file = new File([bytes], label, { type });
        const dt = new DataTransfer(); dt.items.add(file);
        const input = document.getElementById("uploadImage");
        input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      }, { base64: fs.readFileSync(path.join(fixtures, "face.jpg")).toString("base64"), label, type });
      const data = await outcome(page);
      assert.equal(data.processed, 1, "MIME-less / octet-stream JPEG should still be decoded");
      assert.equal(data.events.find(e => e.name === "upload_started").upload_format, expectedFormat);
      observations.push({ filename: "provider MIME " + (type || "empty"), result: "pass" });
    } finally { await page.close(); }
  }

  // Android photo providers sometimes report JPEG metadata for HEIC/TIFF bytes.
  // Recovery text must describe the actual signature after a failed decode.
  for (const [label, signature, hint] of [
    ["mislabelled-heic", [0,0,0,24,102,116,121,112,104,101,105,99], "HEIC"],
    ["mislabelled-tiff", [73,73,42,0,0,0,0,0,0,0,0,0], "TIFF"],
  ]) {
    const page = await setup();
    try {
      await page.evaluate(({ signature }) => {
        const file = new File([new Uint8Array(signature)], "camera.jpg", { type: "image/jpeg" });
        const dt = new DataTransfer(); dt.items.add(file);
        const input = document.getElementById("uploadImage");
        input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      }, { signature });
      await page.waitForFunction((hint) =>
        qa.events.some(e => e.name === "upload_error" && e.error_type === "image_decode") &&
        document.getElementById("toast").textContent.includes(hint), { timeout: 15000 }, hint);
      const data = await outcome(page);
      assert.equal(data.events.find(e => e.name === "upload_started").upload_format, "jpeg");
      assert.equal(data.events.find(e => e.name === "upload_error").stage, "decode");
      assert.equal(data.created, data.revoked, "Failed photo must release object URL");
      observations.push({ filename: label, result: "specific recovery guidance" });
    } finally { await page.close(); }
  }

  for (const fault of ["throw", "stall"]) {
    const page = await setup();
    try {
      await page.evaluate((fault) => {
        File.prototype.slice = fault === "throw"
          ? () => { throw new Error("QA inaccessible cloud-provider header"); }
          : () => ({ arrayBuffer: () => new Promise(() => {}) });
        const file = new File([new Uint8Array([1,2,3,4])], "camera.jpg", { type: "image/jpeg" });
        const dt = new DataTransfer(); dt.items.add(file);
        const input = document.getElementById("uploadImage");
        input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      }, fault);
      await page.waitForFunction(() =>
        qa.events.some(e => e.name === "upload_error" && e.error_type === "image_decode") &&
        document.getElementById("toast").textContent.includes("JPG, PNG 또는 WebP"), { timeout: 5000 });
      const data = await outcome(page);
      assert.equal(data.created, data.revoked, "Unreadable provider must release Blob");
      observations.push({ filename: "provider header " + fault, result: "bounded generic recovery" });
    } finally { await page.close(); }
  }

  const nonImage = await setup();
  try {
    await nonImage.evaluate(() => {
      const file = new File([new Uint8Array([37,80,68,70])], "secret-document.pdf", { type: "application/pdf" });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById("uploadImage");
      input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const data = await outcome(nonImage);
    assert.equal(data.events.find(e => e.name === "upload_error")?.error_type, "unsupported_type");
    assert.equal(data.processed, 0);
    assert.ok(!JSON.stringify(data.events).includes("secret-document"));
    observations.push({ filename: "nonimage PDF privacy/preflight", result: "pass" });
  } finally { await nonImage.close(); }

  // Full application path (not mocked processImage): guarantee canvas failures have
  // a terminal error event and release the progress overlay.
  const page2 = await browser.newPage();
  page2.on("pageerror", (e) => errors.push(e.message));
  await page2.setRequestInterception(true);
  page2.on("request", r => r.url().startsWith(base) ? r.continue() : r.abort());
  try {
    await page2.goto(base, { waitUntil: "domcontentloaded" });
    await page2.evaluate(() => {
      window.qa = { events: [] };
      trackEvent = (name, params = {}) => qa.events.push({ name, ...params });
      toDetectionCanvas = () => { throw new Error("QA: pixel canvas unavailable"); };
    });
    await (await page2.$("#uploadImage")).uploadFile(path.join(fixtures, "face.png"));
    await page2.waitForFunction(() => qa.events.some(e => e.name === "analysis_error" && e.error_type === "canvas_snapshot"), { timeout: 15000 });
    await page2.waitForFunction(() => document.getElementById("loadingModal").style.display === "none", { timeout: 15000 });
    observations.push({ filename: "canvas/loader failure cleanup", result: "pass" });
  } finally { await page2.close(); }

  assert.deepEqual(errors, [], "No uncaught browser JS errors");
  console.log(JSON.stringify({ status: "PASS", tests: observations.length, observations, pageErrors: errors.length, externalRequestsBlocked: blocked.length }, null, 2));
} finally { await browser.close(); }
