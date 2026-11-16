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
  ["face.tiff", "tiff", "processed"],
  ["face.heic", "heic", "processed"],
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
      if (filename === "face.heic") {
        assert.equal(data.processed, 1, "Actual HEIC pixels must be analyzed in-browser");
        const decoded = await page.evaluate(() => qa.events.find(e => e.name === "upload_decode_recovered"));
        assert.equal(decoded?.recovery_method, "heic_decoder", "HEIC conversion must use the explicit decoder");
      }
      if (filename === "face.jpg") {
        const loaded = await page.evaluate(() =>
          performance.getEntriesByType("resource").some(e => e.name.includes("heic2any.min.js")));
        assert.equal(loaded, false, "Normal JPEG must never download the HEIC decoder");
      }
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
      // The self-hosted HEIC decoder maintains one page-lifetime worker Blob
      // URL; the selected photo URL itself must still be revoked on failure.
      assert.equal(data.created - data.revoked, label === "mislabelled-heic" ? 1 : 0,
        "Failed photo must be released (one library worker URL may remain)");
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
        /(JPG|JPEG|PNG|WebP)/i.test(document.getElementById("toast").textContent), { timeout: 5000 });
      const data = await outcome(page);
      assert.equal(data.created, data.revoked, "Unreadable provider must release Blob");
      observations.push({ filename: "provider header " + fault, result: "bounded generic recovery" });
    } finally { await page.close(); }
  }

  // Android Chrome can fail to decode a provider-backed Blob URL using an
  // Image element even when its native ImageBitmap path accepts the same bytes.
  // Exercise the real fallback with a JPEG file, not a fake decoded bitmap.
  const recoveredPage = await setup();
  try {
    await recoveredPage.evaluate(() => {
      const originalWait = setImageSourceAndWait;
      let waits = 0;
      setImageSourceAndWait = (img, src, timeout) =>
        ++waits === 1 ? Promise.reject(new Error("QA ImageElement provider decode failed"))
          : originalWait(img, src, timeout);
    });
    await (await recoveredPage.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    const recovered = await outcome(recoveredPage);
    assert.equal(recovered.processed, 1, "Native ImageBitmap should recover ImageElement decode failure");
    assert.equal(recovered.created, 2, "Only failed original and recovered Blob URL are created");
    assert.equal(recovered.revoked, 1, "Failed original URL must be revoked on recovery");
    assert.equal(recovered.currentPhoto, true, "Recovered image remains available for preview/share");
    assert.equal(recovered.events.filter(e => e.name === "upload_error").length, 0, "Recovered decode is not counted as a failure");
    const recoveredEvent = await recoveredPage.evaluate(() => qa.events.filter(e => e.name === "upload_decode_recovered"));
    assert.equal(recoveredEvent.length, 1, "Recovered native decoding must be observable");
    assert.ok(!JSON.stringify(recoveredEvent).includes("face.jpg"), "No photo filename in recovery telemetry");
    await recoveredPage.evaluate(() => commitIntroState());
    const afterReset = await recoveredPage.evaluate(() => ({ created: qa.created.length, revoked: qa.revoked.length }));
    assert.deepEqual(afterReset, { created: 2, revoked: 2 }, "Recovered photo URL must be released on reset");
    observations.push({ filename: "Android native bitmap recovery", result: "processed, no leak" });
  } finally { await recoveredPage.close(); }

  const failedRecoveryPage = await setup();
  try {
    await failedRecoveryPage.evaluate(() => {
      setImageSourceAndWait = async () => { throw new Error("QA image decoder failed"); };
      createImageBitmap = async () => { throw new Error("QA bitmap decoder also failed"); };
    });
    await (await failedRecoveryPage.$("#uploadImage")).uploadFile(path.join(fixtures, "corrupt.jpg"));
    const failed = await outcome(failedRecoveryPage);
    assert.equal(failed.processed, 0, "Failed native bitmap must not enter face analysis");
    assert.equal(failed.events.find(e => e.name === "upload_error")?.error_type, "image_decode");
    assert.equal(failed.created, failed.revoked, "Both failed decoder paths must free Blob URLs");
    observations.push({ filename: "native recovery fails closed", result: "image_decode" });
  } finally { await failedRecoveryPage.close(); }

  // An Android provider may never settle the secondary native decode.
  // Bound the attempt, release a late bitmap, and keep the original error.
  const slowBitmapPage = await setup();
  try {
    await slowBitmapPage.evaluate(() => {
      qa.lateBitmapClosed = 0;
      setImageSourceAndWait = async () => { throw new Error("QA image element decode fails"); };
      const realRecovery = recoverPhotoBlobWithNativeBitmap;
      recoverPhotoBlobWithNativeBitmap = (file) => realRecovery(file, 60);
      createImageBitmap = async () => {
        await new Promise(resolve => setTimeout(resolve, 180));
        return { close() { qa.lateBitmapClosed++; } };
      };
    });
    await (await slowBitmapPage.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    const result = await outcome(slowBitmapPage);
    assert.equal(result.events.find(e => e.name === "upload_error")?.error_type, "image_decode");
    assert.equal(result.created, result.revoked, "Stalled native decoder must release the original URL");
    await slowBitmapPage.evaluate(() => new Promise(resolve => setTimeout(resolve, 240)));
    assert.equal(await slowBitmapPage.evaluate(() => qa.lateBitmapClosed), 1, "Late native bitmap must be closed");
    observations.push({ filename: "bounded slow native provider recovery", result: "image_decode, late bitmap closed" });
  } finally { await slowBitmapPage.close(); }

  const boundedBitmapPage = await setup();
  try {
    const bounded = await boundedBitmapPage.evaluate(async () => {
      let attempts = 0;
      let closed = 0;
      const realBitmap = createImageBitmap;
      createImageBitmap = () => { attempts++; return Promise.resolve({ width: 12000, height: 12000, close() { closed++; } }); };
      const massivePixels = await recoverPhotoBlobWithNativeBitmap(new File([new Uint8Array([0xff, 0xd8])], "large.jpg", { type: "image/jpeg" }), 100);
      const overBudget = new File([new Uint8Array(21 * 1024 * 1024)], "huge.jpg", { type: "image/jpeg" });
      const skipped = await recoverPhotoBlobWithNativeBitmap(overBudget, 100);
      createImageBitmap = realBitmap;
      return { massivePixels, skipped, attempts, closed };
    });
    assert.deepEqual(bounded, { massivePixels: null, skipped: null, attempts: 1, closed: 1 }, "Native recovery must enforce pixel/byte budgets");
    observations.push({ filename: "native bitmap resource limits", result: "pixel/byte budgets, bitmap closed" });
  } finally { await boundedBitmapPage.close(); }

  // Android's Files/Photos picker can describe HEIC bytes as a JPEG.
  // Accept the actual HEIC content (not just a 12-byte signature stub),
  // run the existing local face-analysis input, and never expose filenames.
  const realMislabelledHeicPage = await setup();
  try {
    await realMislabelledHeicPage.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const file = new File([bytes], "private-client-photo.jpg", { type: "image/jpeg" });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById("uploadImage");
      input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    }, fs.readFileSync(path.join(fixtures, "face.heic")).toString("base64"));
    await realMislabelledHeicPage.waitForFunction(() => qa.processed === 1, { timeout: 20000 });
    const state = await realMislabelledHeicPage.evaluate(() => ({
      processed: qa.processed,
      events: qa.events,
      imageWidth: document.getElementById("uploadedImage").naturalWidth,
      imageHeight: document.getElementById("uploadedImage").naturalHeight,
    }));
    assert.equal(state.imageWidth, 640);
    assert.equal(state.imageHeight, 640);
    assert.equal(state.events.find(e => e.name === "upload_decode_recovered")?.recovery_method, "heic_decoder");
    assert.equal(state.events.filter(e => e.name === "upload_error").length, 0);
    assert.ok(!JSON.stringify(state.events).includes("private-client-photo"), "No HEIC filename in analytics");
    observations.push({ filename: "provider JPEG MIME with actual HEIC bytes", result: "converted, analyzed, no personal data" });
  } finally { await realMislabelledHeicPage.close(); }

  // TIFF provider cases: valid LZW, misleading JPEG MIME and excessive pixel
  // headers must not consume unlimited memory or leak the actual photo.
  const lzwFixture = path.join(fixtures, "face-lzw.tiff");
  for (const [label, name, mime, bytesPath] of [
    ...(fs.existsSync(lzwFixture) ? [["TIFF LZW compression", "photo.tiff", "image/tiff", lzwFixture]] : []),
    ["TIFF mislabeled JPEG", "secret-person.jpg", "image/jpeg", path.join(fixtures, "face.tiff")],
  ]) {
    const page = await setup();
    try {
      await page.evaluate(({ base64, name, mime }) => {
        const buf = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const f = new File([buf], name, { type: mime });
        const transfer = new DataTransfer(); transfer.items.add(f);
        const input = document.getElementById("uploadImage");
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, { base64: fs.readFileSync(bytesPath).toString("base64"), name, mime });
      await page.waitForFunction(() => qa.processed > 0 || qa.events.some(e => e.name === "upload_error"), {timeout: 20000});
      const data = await outcome(page);
      assert.equal(data.processed, 1, label + " must decode; observed=" + JSON.stringify(data));
      assert.equal(data.events.filter(e => e.name === "upload_error").length, 0);
      const recovered = await page.evaluate(() => qa.events.find(e => e.name === "upload_decode_recovered"));
      assert.equal(recovered?.recovery_method, "tiff_worker");
      assert.ok(!JSON.stringify(recovered).includes("secret-person"));
      observations.push({ filename: label, result: "decoded via bounded local worker" });
    } finally { await page.close(); }
  }

  // A compressed tiny TIFF may announce huge dimensions. The worker must
  // reject its header before any image decompression or pixel allocation.
  const bigTiffPage = await setup();
  try {
    const state = await bigTiffPage.evaluate(async () => {
      const bytes = new Uint8Array([
        73,73,42,0, 8,0,0,0, 2,0,
        0,1,4,0,1,0,0,0,16,39,0,0,
        1,1,4,0,1,0,0,0,16,39,0,0,
        0,0,0,0,
      ]);
      return recoverTiffPhotoBlob(new File([bytes], "bomb.tiff", {type:"image/tiff"}), 900);
    });
    assert.equal(state, null, "Metadata-advertised 100MP TIFF must be rejected before decompression");
    observations.push({ filename: "TIFF excessive decompressed pixel header", result: "rejected safely" });
  } finally { await bigTiffPage.close(); }

  const hungTiffPage = await setup();
  try {
    const result = await hungTiffPage.evaluate(async () => {
      const NativeWorker = Worker;
      let terminated = 0;
      Worker = class { constructor(){ } postMessage(){} terminate(){terminated++;} };
      const file = new File([new Uint8Array([73,73,42,0,8,0,0,0])], "slow.tiff", {type:"image/tiff"});
      const blob = await recoverTiffPhotoBlob(file, 50);
      Worker = NativeWorker;
      return { nullResult: blob === null, terminated };
    });
    assert.deepEqual(result, {nullResult:true, terminated:1}, "Unresponsive TIFF worker must terminate on timeout");
    observations.push({ filename: "TIFF worker stalls", result: "bounded timeout and termination" });
  } finally { await hungTiffPage.close(); }

  const abortedTiffPage = await setup();
  try {
    const result = await abortedTiffPage.evaluate(async () => {
      const NativeWorker = Worker;
      let terminated = 0;
      Worker = class { constructor(){ } postMessage(){} terminate(){terminated++;} };
      const controller = new AbortController();
      const file = new File([new Uint8Array([73,73,42,0,8,0,0,0])], "canceled.tiff", {type:"image/tiff"});
      const pending = recoverTiffPhotoBlob(file, 9000, controller.signal);
      await new Promise(resolve => setTimeout(resolve, 50));
      controller.abort();
      const blob = await pending;
      Worker = NativeWorker;
      return { nullResult: blob === null, terminated };
    });
    assert.deepEqual(result, {nullResult:true, terminated:1}, "Canceled TIFF conversion must terminate immediately, not wait for the 9s timeout");
    observations.push({ filename: "TIFF worker cancellation", result: "immediate termination" });
  } finally { await abortedTiffPage.close(); }

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
