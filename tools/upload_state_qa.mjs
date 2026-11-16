import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(os.homedir(), ".local/lib/node_modules/hyperframes/package.json"));
const base = process.env.RICHCHECKER_QA_URL || "http://127.0.0.1:18978/";
const fixtures = process.env.RICHCHECKER_QA_FIXTURES || "/private/tmp/richchecker-upload-fixtures";
const browser = await require("puppeteer-core").launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--no-sandbox"],
});
const results = [];
async function pageSetup() {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (request.url().startsWith(base) || request.url().startsWith("blob:") || request.url().startsWith("data:")) return request.continue();
    return request.abort();
  });
  await page.setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36");
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.qa = { processed: [], events: [], created: [], revoked: [], gateEntered: false };
    trackEvent = (name, params = {}) => qa.events.push({ name, ...params });
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); qa.created.push(url); return url; };
    URL.revokeObjectURL = url => { qa.revoked.push(url); return revoke(url); };
    qa.originalProcessImage = processImage;
    processImage = async (ctx, loadingId) => {
      qa.processed.push(ctx.upload_format);
      qa.events.push({ name: "analysis_complete", ...ctx });
      await hideLoadingModal(loadingId);
    };
    const original = setImageSourceAndWait;
    let first = true;
    setImageSourceAndWait = async (image, url, timeout, uploadId) => {
      if (first) {
        first = false;
        qa.gateEntered = true;
        await new Promise(resolve => { qa.releaseGate = resolve; });
      }
      return original(image, url, timeout, uploadId);
    };
  });
  return { page, errors };
}
async function state(page) {
  return page.evaluate(() => ({
    processed: qa.processed,
    created: qa.created,
    revoked: qa.revoked,
    imageSrc: document.getElementById("uploadedImage").getAttribute("src"),
    photoVisible: !document.getElementById("uploadedImageContainer").hidden,
    loadingVisible: document.getElementById("loadingModal").style.display !== "none",
    events: qa.events.filter(e => e.name === "upload_error" || e.name === "analysis_complete"),
  }));
}
async function waitForQueue(page, timeoutMs = 3000) {
  let timer;
  try {
    await Promise.race([
      page.evaluate(() => uploadTaskChain),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("upload queue timeout")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function check(label, work) {
  const { page, errors } = await pageSetup();
  try { const result = await work(page); assert.deepEqual(errors, [], label + ": page errors"); results.push({ label, pass: true, state: result }); }
  catch (err) { const diagnostic = label.includes("model-resource") ? await page.evaluate(() => ({ processed: qa.processed, modelWaitEntered: qa.modelWaitEntered, modelWaitCanceled: qa.modelWaitCanceled, events: qa.events.slice(-8), loading: document.getElementById("loadingModal").style.display })) : undefined; results.push({ label, pass: false, error: err.message, diagnostic }); }
  finally { await page.close(); }
}
try {
  await check("reset during delayed image display", async page => {
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    await page.waitForFunction(() => qa.gateEntered && typeof qa.releaseGate === "function");
    await page.evaluate(() => commitIntroState());
    let v = await state(page);
    assert.equal(v.loadingVisible, false, "Reset must immediately clear the old progress overlay");
    await page.evaluate(() => qa.releaseGate());
    await waitForQueue(page);
    v = await state(page);
    assert.deepEqual(v.processed, [], "Canceled image may not be analyzed after reset");
    assert.equal(v.imageSrc, null, "Canceled image may not reappear after reset");
    assert.equal(v.created.length, v.revoked.length, "Canceled URL must be freed");
    return v;
  });
  await check("latest selection wins while previous provider is slow", async page => {
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.png"));
    await page.waitForFunction(() => qa.gateEntered && typeof qa.releaseGate === "function");
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    await page.evaluate(() => qa.releaseGate());
    await waitForQueue(page);
    const v = await state(page);
    assert.deepEqual(v.processed, ["jpeg"], "Old PNG may not be analyzed after newer JPEG selected");
    assert.equal(v.imageSrc?.startsWith("blob:"), true);
    assert.equal(v.created.length - v.revoked.length, 1, "Only latest photo URL remains active");
    assert.equal(v.loadingVisible, false);
    return v;
  });
  await check("reset while HEIC conversion waits", async page => {
    await page.evaluate(() => {
      recoverHeicPhotoBlob = async () => {
        qa.heicEntered = true;
        return new Promise(resolve => { qa.releaseHeic = () => resolve(new Blob([new Uint8Array([1,2,3])], {type:"image/jpeg"})); });
      };
    });
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.heic"));
    await page.waitForFunction(() => qa.gateEntered);
    await page.evaluate(() => qa.releaseGate());
    await page.waitForFunction(() => qa.heicEntered && typeof qa.releaseHeic === "function", {timeout:20000});
    await page.evaluate(() => commitIntroState());
    assert.equal((await state(page)).loadingVisible,false);
    await page.evaluate(() => uploadTaskChain.then(() => { qa.queueFinished = true; }));
    await page.waitForFunction(() => qa.queueFinished === true, {timeout:1600});
    await page.evaluate(() => qa.releaseHeic());
    await waitForQueue(page);
    const v = await state(page);
    assert.deepEqual(v.processed, []);
    assert.equal(v.imageSrc, null);
    assert.equal(v.created.length, v.revoked.length);
    assert.deepEqual(v.events, []);
    return v;
  });
  await check("select JPEG while earlier HEIC conversion waits", async page => {
    await page.evaluate(() => {
      recoverHeicPhotoBlob = async () => {
        qa.heicEntered = true;
        return new Promise(resolve => { qa.releaseHeic = () => resolve(new Blob([new Uint8Array([1,2,3])], {type:"image/jpeg"})); });
      };
    });
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.heic"));
    await page.waitForFunction(() => qa.gateEntered);
    await page.evaluate(() => qa.releaseGate());
    await page.waitForFunction(() => qa.heicEntered && typeof qa.releaseHeic === "function", {timeout:20000});
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    await page.waitForFunction(() => qa.processed.includes("jpeg"), {timeout:1600});
    await page.evaluate(() => qa.releaseHeic());
    await waitForQueue(page);
    const v = await state(page);
    assert.deepEqual(v.processed, ["jpeg"]);
    assert.equal(v.created.length - v.revoked.length, 1);
    assert.equal(v.loadingVisible, false);
    return v;
  });
  await check("reset then immediate new JPEG while earlier decode remains pending", async page => {
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.png"));
    await page.waitForFunction(() => qa.gateEntered && typeof qa.releaseGate === "function");
    await page.evaluate(() => commitIntroState());
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    await page.evaluate(() => qa.releaseGate());
    await waitForQueue(page);
    const v = await state(page);
    assert.deepEqual(v.processed, ["jpeg"]);
    assert.equal(v.created.length - v.revoked.length, 1);
    assert.equal(v.loadingVisible, false);
    return v;
  });
  await check("reset while TIFF worker decode waits", async page => {
    await page.evaluate(() => {
      recoverTiffPhotoBlob = async (file, timeout, signal) => {
        qa.tiffEntered = true;
        qa.tiffSignal = signal;
        return new Promise(resolve => { qa.releaseTiff = () => resolve(new Blob([new Uint8Array([1,2,3])], {type:"image/jpeg"})); });
      };
    });
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.tiff"));
    await page.waitForFunction(() => qa.gateEntered);
    await page.evaluate(() => qa.releaseGate());
    await page.waitForFunction(() => qa.tiffEntered && typeof qa.releaseTiff === "function", {timeout:20000});
    await page.evaluate(() => commitIntroState());
    assert.equal((await state(page)).loadingVisible,false);
    assert.equal(await page.evaluate(() => qa.tiffSignal?.aborted), true, "Reset must abort the actual TIFF worker signal");
    await page.evaluate(() => uploadTaskChain.then(() => { qa.queueFinished = true; }));
    await page.waitForFunction(() => qa.queueFinished === true, {timeout:1600});
    await page.evaluate(() => qa.releaseTiff());
    await waitForQueue(page);
    const v = await state(page);
    assert.deepEqual(v.processed, []);
    assert.equal(v.imageSrc, null);
    assert.equal(v.created.length, v.revoked.length);
    assert.deepEqual(v.events, []);
    return v;
  });
  await check("select JPEG while earlier TIFF worker waits", async page => {
    await page.evaluate(() => {
      recoverTiffPhotoBlob = async (file, timeout, signal) => {
        qa.tiffEntered = true;
        qa.tiffSignal = signal;
        return new Promise(resolve => { qa.releaseTiff = () => resolve(new Blob([new Uint8Array([1,2,3])], {type:"image/jpeg"})); });
      };
    });
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.tiff"));
    await page.waitForFunction(() => qa.gateEntered);
    await page.evaluate(() => qa.releaseGate());
    await page.waitForFunction(() => qa.tiffEntered && typeof qa.releaseTiff === "function", {timeout:20000});
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    await page.waitForFunction(() => qa.processed.includes("jpeg"), {timeout:1600});
    assert.equal(await page.evaluate(() => qa.tiffSignal?.aborted), true, "New selection must abort the previous TIFF worker");
    await page.evaluate(() => qa.releaseTiff());
    await waitForQueue(page);
    const v = await state(page);
    assert.deepEqual(v.processed, ["jpeg"]);
    assert.equal(v.created.length - v.revoked.length, 1);
    assert.equal(v.loadingVisible, false);
    return v;
  });
  await check("burst 12 selections with slow initial photo", async page => {
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.png"));
    await page.waitForFunction(() => qa.gateEntered && typeof qa.releaseGate === "function");
    const burst = Array.from({ length: 12 }, (_, i) => {
      const filename = i === 11 ? "face.webp" : "face.jpg";
      return { filename, mime: filename.endsWith(".webp") ? "image/webp" : "image/jpeg",
        base64: fs.readFileSync(path.join(fixtures, filename)).toString("base64") };
    });
    await page.evaluate(items => {
      const input = document.getElementById("uploadImage");
      for (const item of items) {
        const bytes = Uint8Array.from(atob(item.base64), c => c.charCodeAt(0));
        const file = new File([bytes], item.filename, { type: item.mime });
        const transfer = new DataTransfer(); transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, burst);
    await page.evaluate(() => qa.releaseGate());
    await waitForQueue(page);
    const v = await state(page);
    assert.deepEqual(v.processed, ["webp"]);
    assert.equal(v.created.length - v.revoked.length, 1);
    assert.equal(v.loadingVisible, false);
    return { processed: v.processed, created: v.created.length, revoked: v.revoked.length, loadingVisible:v.loadingVisible };
  });
  await check("new upload must bypass a canceled stalled model-resource wait", async page => {
    await page.evaluate(() => {
      processImage = async (ctx, id, uploadId) => {
        if (ctx.upload_format === "png") {
          qa.modelWaitEntered = true;
          try {
            await awaitActiveUpload(new Promise(resolve => { qa.releaseModules = resolve; }), uploadId, 30000);
          } catch (error) {
            qa.modelWaitCanceled = error.code;
            return;
          }
        }
        qa.processed.push(ctx.upload_format);
        await hideLoadingModal(id);
      };
    });
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.png"));
    await page.waitForFunction(() => qa.gateEntered && typeof qa.releaseGate === "function");
    await page.evaluate(() => qa.releaseGate());
    await page.waitForFunction(() => qa.modelWaitEntered && typeof qa.releaseModules === "function", {timeout:10000});
    await (await page.$("#uploadImage")).uploadFile(path.join(fixtures, "face.jpg"));
    await page.waitForFunction(() => qa.processed.includes("jpeg"), {timeout:1600});
    const v = await state(page);
    assert.deepEqual(v.processed, ["jpeg"]);
    assert.equal(v.loadingVisible, false);
    assert.equal(v.created.length - v.revoked.length, 1);
    const canceled = await page.evaluate(() => qa.modelWaitCanceled);
    assert.equal(canceled, "UPLOAD_CANCELLED");
    return {processed:v.processed,loadingVisible:v.loadingVisible,canceled};
  });
} finally {
  const child = browser.process();
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
}
console.log(JSON.stringify({ status: results.every(r => r.pass) ? "PASS" : "FAIL", tests: results.length, results }, null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;
