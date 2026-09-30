import fs from "node:fs"

const script = fs.readFileSync(new URL("../js/script.js", import.meta.url), "utf8")

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

const processStart = script.indexOf("async function processImage(")
const processEnd = script.indexOf("\n// Lucide", processStart)
if (processStart < 0 || processEnd < 0) throw new Error("Could not isolate processImage")
const processBlock = script.slice(processStart, processEnd)
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

console.log("PASS runtime contract: decode gate, deduped warmup, exclusive outcome, acquisition/performance telemetry")
