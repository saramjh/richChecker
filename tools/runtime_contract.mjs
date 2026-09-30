import fs from "node:fs"

const script = fs.readFileSync(new URL("../js/script.js", import.meta.url), "utf8")
const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8")

function requireText(text, label) {
  if (!script.includes(text)) throw new Error("Missing runtime contract: " + label)
}

requireText("function setImageSourceAndWait(img, src)", "source-specific image readiness gate")
requireText("await setImageSourceAndWait(uploadedImage, dataUrl)", "new image load before analysis")
requireText("let mediapipeModulesPromise = null", "module promise dedupe")
requireText("let faceLandmarkerPromise = null", "landmarker promise dedupe")
requireText("let coreWarmupPromise = null", "eager core warmup dedupe")
requireText('startCoreWarmup("startup")', "startup warmup begins during deferred runtime execution")
requireText('modal.style.opacity = "1"', "repeat-analysis loader visibility reset")
requireText("let loadingRunId = 0", "loading run generation guard")
requireText("if (runId !== loadingRunId) return", "stale loader cleanup guard")
requireText("let preparedShareBlob = null", "prepared share image cache")
requireText("async function prepareShareArtifact()", "background share image preparation")
requireText("function sharePreparedCard(fallbackMessage)", "gesture-safe prepared sharing")
requireText("let outcomeTracked = false", "exclusive analysis outcome guard")
requireText('trackEvent("analysis_error", eventParams({ error_type: errorType, stage }))', "stage-aware error telemetry")
requireText('trackEvent("app_entry")', "entry event")
requireText("function classifyEntryReferrer()", "internal acquisition referrer classification")
requireText('timings.detection_ms', "detection timing")
requireText("async function detectFaceWithRetry(landmarker, initialCanvas)", "bounded detection retry")
requireText("timings.detection_attempts", "detection retry telemetry")
requireText("let uploadTaskChain = Promise.resolve()", "serialized upload analysis")
requireText("uploadTaskChain = uploadTaskChain.catch(() => {}).then(async () =>", "queued upload processing")
requireText("setTimeout(finish, 500)", "loading cleanup timeout fallback")
requireText("function initializeResultAds()", "non-fatal result ad initialization")
requireText('console.warn("Result ad initialization skipped:", err)', "ad failure isolation")
requireText('timings.matching_ms', "matching timing")
requireText('timings.render_ms', "render timing")
requireText('id="topMatchPercent">${match.similarityDisplay}%', "static similarity value")

if (!index.includes('js/script.js?v=20260930-runtime-spacing3')) throw new Error("Missing versioned runtime script URL")

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
const clearInputPos = uploadBlock.indexOf('this.value = ""')
const readyPos = uploadBlock.indexOf("await setImageSourceAndWait(uploadedImage, dataUrl)")
const analysisPos = uploadBlock.indexOf("await processImage(")
if (!(clearInputPos >= 0 && readyPos > clearInputPos && analysisPos > readyPos)) {
  throw new Error("Upload flow must clear the file input, wait for the newly selected image, then analyze")
}
const sourceGateStart = script.indexOf("function setImageSourceAndWait(img, src)")
const sourceGateEnd = script.indexOf("\n\n// 이미지 업로드 시 처리", sourceGateStart)
const sourceGateBlock = script.slice(sourceGateStart, sourceGateEnd)
const listenerPos = sourceGateBlock.indexOf('img.addEventListener("load", onLoad)')
const assignPos = sourceGateBlock.indexOf("img.src = src")
if (!(listenerPos >= 0 && assignPos > listenerPos)) {
  throw new Error("New image load listener must be installed before changing img.src")
}

if (script.includes("scheduleCoreWarmup()")) throw new Error("Core warmup regressed to delayed window-load scheduling")
const preparedShareStart = script.indexOf("function sharePreparedCard(fallbackMessage)")
const preparedShareEnd = script.indexOf('document.getElementById("webShareBtn")', preparedShareStart)
const preparedShareBlock = script.slice(preparedShareStart, preparedShareEnd)
if (preparedShareBlock.includes("await captureShareCard") || preparedShareBlock.includes("canvas.toBlob")) {
  throw new Error("Share click path must not perform expensive card rendering before navigator.share")
}
if (!index.includes('css/style.css?v=20260930-runtime-spacing3')) throw new Error("Missing versioned result CSS URL")
if (!index.includes('<div id="averageResult"></div>')) throw new Error("Result host must be a block container")
if (!index.includes('class="result-actions"')) throw new Error("Result controls must be grouped for shared spacing")

console.log("PASS runtime contract: source-specific image gate, same-file retry, first-upload snapshot, bounded detection retry, deduped warmup, exclusive outcome, acquisition/performance telemetry")
