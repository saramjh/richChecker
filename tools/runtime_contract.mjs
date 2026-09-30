import fs from "node:fs"

const script = fs.readFileSync(new URL("../js/script.js", import.meta.url), "utf8")
const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8")

function requireText(text, label) {
  if (!script.includes(text)) throw new Error("Missing runtime contract: " + label)
}

requireText("function waitForImageReady(img)", "image readiness gate")
requireText("await waitForImageReady(uploadedImage)", "image decode before analysis")
requireText("let mediapipeModulesPromise = null", "module promise dedupe")
requireText("let faceLandmarkerPromise = null", "landmarker promise dedupe")
requireText("let outcomeTracked = false", "exclusive analysis outcome guard")
requireText('trackEvent("analysis_error", eventParams({ error_type: errorType, stage }))', "stage-aware error telemetry")
requireText('trackEvent("app_entry")', "entry event")
requireText("function classifyEntryReferrer()", "internal acquisition referrer classification")
requireText('timings.detection_ms', "detection timing")
requireText('timings.matching_ms', "matching timing")
requireText('timings.render_ms', "render timing")

if (!index.includes('id="uploadedImage"') || !index.includes('src="assets/imgs/placeholder.svg"')) {
  throw new Error("Initial upload placeholder must be owned by index.html")
}
if (script.includes("window.onload = function ()")) {
  throw new Error("Do not mutate upload state from window.onload; it races the first user selection")
}
const placeholderWrites = script.match(/uploadedImage\.src = "assets\/imgs\/placeholder\.svg"/g) || []
if (placeholderWrites.length !== 1) {
  throw new Error("Placeholder src may only be restored by the explicit reset action")
}

const processStart = script.indexOf("async function processImage(")
const processEnd = script.indexOf("\n// Lucide", processStart)
if (processStart < 0 || processEnd < 0) throw new Error("Could not isolate processImage")
const processBlock = script.slice(processStart, processEnd)
const snapshotPos = processBlock.indexOf('const detectionCanvas = toDetectionCanvas(document.getElementById("uploadedImage"))')
const moduleWaitPos = processBlock.indexOf('modules = await timed("modules_ready"')
const modelWaitPos = processBlock.indexOf('landmarker = await timed("model_ready"')
if (snapshotPos < 0 || moduleWaitPos < 0 || modelWaitPos < 0 || snapshotPos >= moduleWaitPos || snapshotPos >= modelWaitPos) {
  throw new Error("Selected image pixels must be snapshotted before async model/module waits")
}

const renderPos = processBlock.indexOf("renderResults(")
const completePos = processBlock.indexOf('trackEvent("analysis_complete"')
if (renderPos < 0 || completePos < 0 || renderPos >= completePos) {
  throw new Error("analysis_complete must be emitted only after renderResults succeeds")
}

const uploadStart = script.indexOf('document.getElementById("uploadImage").addEventListener("change"')
const uploadEnd = script.indexOf("\n// data/embeddings.json:", uploadStart)
if (uploadStart < 0 || uploadEnd < 0) throw new Error("Could not isolate upload handler")
const uploadBlock = script.slice(uploadStart, uploadEnd)
const srcPos = uploadBlock.indexOf("uploadedImage.src = e.target.result")
const readyPos = uploadBlock.indexOf("await waitForImageReady(uploadedImage)")
const analysisPos = uploadBlock.indexOf("await processImage(")
if (!(srcPos >= 0 && readyPos > srcPos && analysisPos > readyPos)) {
  throw new Error("Upload flow must set src, await decode, then analyze")
}

console.log("PASS runtime contract: decode gate, first-upload snapshot, deduped warmup, exclusive outcome, acquisition/performance telemetry")
