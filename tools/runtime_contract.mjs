import fs from "node:fs"

const script = fs.readFileSync(new URL("../js/script.js", import.meta.url), "utf8")
const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8")
const tiffWorker = fs.readFileSync(new URL("../assets/vendor/tiff-worker.js", import.meta.url), "utf8")
const utif = fs.readFileSync(new URL("../assets/vendor/utif.js", import.meta.url), "utf8")

function requireText(text, label) {
  if (!script.includes(text)) throw new Error("Missing runtime contract: " + label)
}
function requireWorkerText(text, label) {
  if (!tiffWorker.includes(text)) throw new Error("Missing TIFF worker contract: " + label)
}
requireWorkerText('importScripts("pako_inflate.min.js?v=20261116-tiff-bounds", "utif.js?v=20261116-tiff-bounds")', "self-hosted decoder dependencies")
requireWorkerText("const MAX_TIFF_PIXELS = 8_000_000", "pre-decompression pixel budget")
requireWorkerText("const MAX_TIFF_DECODE_BYTES = 32 * 1024 * 1024", "decoded-byte budget")
requireWorkerText("const MAX_TIFF_IFD_ENTRIES = 256", "bounded TIFF metadata entry count")
requireWorkerText("function preflightFirstIfd(buffer)", "bounded first-page metadata parsing")
requireWorkerText("self.pako.inflate = boundedInflate", "bounded Deflate expansion")
if (!utif.includes('maxOutputLength:maxOutputLength')) throw new Error("Missing TIFF Deflate per-strip output cap")
requireWorkerText("data.byteLength > 12 * 1024 * 1024", "bounded source bytes")
requireWorkerText('self.postMessage({ ok: true, width, height, pixels: rgba.buffer }, [rgba.buffer])', "transfer decoded pixels without copying")
if (/\b(fetch|XMLHttpRequest|WebSocket)\b/.test(tiffWorker)) throw new Error("TIFF worker must not make network requests")
for (const license of ["utif.LICENSE.txt", "pako.LICENSE.txt"]) {
  const text = fs.readFileSync(new URL("../assets/vendor/" + license, import.meta.url), "utf8")
  if (!text.includes("MIT License") && !text.includes("The MIT License")) throw new Error("Missing MIT license notice: " + license)
}

requireText("function setImageSourceAndWait(img, src, timeoutMs = 20000, uploadId = uploadRevision)", "source-specific image readiness gate")
requireText("await awaitActiveUpload(setImageSourceAndWait(uploadedImage, photoUrl, 20000, thisUpload), thisUpload)", "cancelable new image load before analysis")
requireText("async function recoverTiffPhotoBlob(file, timeoutMs = 9000, signal = null)", "worker-limited TIFF decode")
requireText("async function recoverHeicPhotoBlob(file, timeoutMs = 10000)", "local HEIC decode for unsupported photos")
requireText("async function recoverPhotoBlobWithNativeBitmap(file, timeoutMs = 7000)", "bounded native recovery for Android providers")
requireText("let mediapipeModulesPromise = null", "module promise dedupe")
requireText("let faceLandmarkerPromise = null", "landmarker promise dedupe")
requireText("let coreWarmupPromise = null", "eager core warmup dedupe")
requireText('startCoreWarmup("startup")', "startup warmup begins during deferred runtime execution")
requireText("let loadingRunId = 0", "loading run generation guard")
requireText("const MOTION = Object.freeze", "central motion policy")
requireText("function prefersReducedMotion()", "central reduced-motion policy")
requireText("function commitIntroState()", "single reset-state owner")
requireText("async function hydrateSharedChallenge()", "shared challenge hydration")
requireText('let entryContext = "standard"', "unverified share analytics isolation")
requireText('entryContext = "shared_result"', "validated share analytics promotion")
requireText("entry_context: entryContext", "entry context attribution")
requireText("function buildChallengeUrl()", "challenge URL sharing")
requireText("commitIntroState()", "reset state commits before decorative motion")
if (script.includes("MIN_LOADING_MS") || script.includes("loadingStartedAt")) throw new Error("Do not enforce a minimum analysis wait")
requireText('displayLoadingFace(detectionCanvas, activeLoadingSessionId)', "actual selected pixels in analysis UI")
requireText('modules.createFaceGeometry(landmarks, analyzedCanvas.width, analyzedCanvas.height)', "geometry from actual detected landmarks")
requireText('setLoadingStage(1, activeLoadingSessionId)', "status from actual detection stage")
requireText("revealResultFaceMotion()", "nonblocking result-photo continuation")
requireText('modal.style.opacity = "1"', "immediate full-screen response")
requireText('content.style.opacity = "1"', "immediate progress-card response")
requireText("const loadingSessionId = showLoadingModal()", "loader begins before file read")
requireText("async function hideLoadingModal(runId = loadingRunId, immediate = false)", "loader session ownership")
requireText('document.body.classList.add("result-mode")', "long result top alignment")
requireText('window.scrollTo({ top: 0, left: 0, behavior: "auto" })', "state transition scroll reset")
requireText("function revealRenderedResults()", "post-loader result reveal")
requireText("if (runId !== loadingRunId) return", "stale loader cleanup guard")
requireText("let preparedShareBlob = null", "prepared share image cache")
requireText("async function prepareShareArtifact()", "background share image preparation")
requireText("function armShareArtifactPreparation()", "viewport-proximity share preparation")
requireText("function cancelShareArtifactPreparation()", "cancellable share preparation")
requireText("scheduleShareArtifactPreparation(420)", "share capture delayed behind transitions")
requireText('rootMargin: "560px 0px"', "share preparation proximity threshold")
requireText("function sharePreparedCard(fallbackMessage, method)", "gesture-safe prepared sharing")
requireText('el.style.display = "none"', "share card hidden after capture")
requireText("let outcomeTracked = false", "exclusive analysis outcome guard")
requireText('trackEvent("analysis_error", eventParams({ error_type: errorType, stage }))', "stage-aware error telemetry")
requireText('trackEvent("app_entry")', "entry event")
requireText("function classifyEntryReferrer()", "internal acquisition referrer classification")
requireText('timings.detection_ms', "detection timing")
requireText("async function detectFaceWithRetry(landmarker, initialCanvas)", "bounded detection retry")
requireText("timings.detection_attempts", "detection retry telemetry")
requireText("function awaitActiveUpload(promise, uploadId, timeoutMs = 0, cancelWork = null)", "cancelable upload and model waits")
requireText("activeLoadingSessionId === loadingRunId && uploadId === uploadRevision", "stale analysis cannot clear new upload styles")
requireText("recoverTiffPhotoBlob(file, 9000, recoveryController?.signal)", "abortable TIFF worker conversion")
requireText('new Worker("assets/vendor/tiff-worker.js?v=20261116-tiff-bounds")', "cache-busted hardened TIFF worker")
requireText("let uploadTaskChain = Promise.resolve()", "serialized upload analysis")
requireText("function waitForUiPaint()", "UI paint yield before analysis")
requireText("await waitForUiPaint()", "processing state paints before heavy work")
requireText("uploadTaskChain = uploadTaskChain.catch(() => {}).then(async () =>", "queued upload processing")
requireText("setTimeout(finish, 380)", "loading cleanup timeout fallback")
requireText("function initializeBottomAd()", "non-fatal bottom ad initialization")
requireText('console.warn("Bottom ad initialization skipped:", err)', "ad failure isolation")
requireText("function observeBottomAd()", "viewport-based ad initialization")
if ((index.match(/class="adsbygoogle"/g) || []).length !== 1) throw new Error("Keep exactly one existing ad unit")
if (!index.includes('id="bottomAd"')) throw new Error("Bottom ad missing")
requireText('ins.dataset.adRequested = "true"', "prevent duplicate ad requests on results/reset")
requireText('timings.matching_ms', "matching timing")
requireText('timings.render_ms', "render timing")
requireText('id="topMatchPercent">${match.similarityDisplay}%', "static similarity value")

if (!index.includes('js/script.js?v=20261116-upload-safe3')) throw new Error("Missing versioned runtime script URL")

if (!index.includes('id="uploadedImageContainer" hidden') || !index.includes('id="choosePhotoBtn" type="button"')) {
  throw new Error("Initial photo entry must keep the native CTA and hide the undecoded photo")
}
if (!index.includes('id="photoSlot" type="button"')) throw new Error("Initial photo slot must be a native whole-area action")
if (index.indexOf('id="photoSlot"') > index.indexOf('id="choosePhotoBtn"')) throw new Error("Photo slot must precede start CTA")
requireText('openPhotoPicker("photo_slot")', "photo slot uses the existing picker/analysis pipeline")
requireText('document.getElementById("photoSlot").hidden = true', "real photo replaces empty slot")
requireText('document.getElementById("photoSlot").hidden = false', "empty slot restored on reset")
if ((index + script).includes('assets/imgs/placeholder.svg')) {
  throw new Error("Do not display or restore a fake upload photo")
}
if (script.includes("window.onload = function ()")) {
  throw new Error("Do not mutate upload state from window.onload; it races the first user selection")
}
const resetImageClears = script.match(/uploadedImage\.removeAttribute\("src"\)/g) || []
if (resetImageClears.length !== 6) {
  throw new Error("Decode recovery, final decode failure and explicit reset should clear the image")
}
requireText("uploadContainer.hidden = true", "photo frame hidden on reset and before decode")
requireText("uploadContainer.hidden = false", "decoded photo frame restored")

const processStart = script.indexOf("async function processImage(")
const processEnd = script.indexOf("\n// Lucide", processStart)
if (processStart < 0 || processEnd < 0) throw new Error("Could not isolate processImage")
const processBlock = script.slice(processStart, processEnd)
const snapshotPos = processBlock.indexOf('detectionCanvas = toDetectionCanvas(document.getElementById("uploadedImage"))')
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
const loaderPos = uploadBlock.indexOf("const loadingSessionId = showLoadingModal()")
const readerPos = uploadBlock.indexOf("URL.createObjectURL(file)")
const readyPos = uploadBlock.indexOf("await awaitActiveUpload(setImageSourceAndWait(uploadedImage, photoUrl, 20000, thisUpload), thisUpload)")
const analysisPos = uploadBlock.indexOf("await processImage(")
if (!(clearInputPos >= 0 && loaderPos > clearInputPos && readerPos > loaderPos && readyPos > readerPos && analysisPos > readyPos)) {
  throw new Error("Upload flow must show processing immediately, then acquire a local Blob URL and decode the selected image before analysis")
}
const sourceGateStart = script.indexOf("function setImageSourceAndWait(img, src, timeoutMs = 20000, uploadId = uploadRevision)")
const sourceGateEnd = script.indexOf("\n\n// 이미지 업로드 시 처리", sourceGateStart)
const sourceGateBlock = script.slice(sourceGateStart, sourceGateEnd)
const listenerPos = sourceGateBlock.indexOf('img.addEventListener("load", onLoad)')
const assignPos = sourceGateBlock.indexOf("img.src = src")
if (!(listenerPos >= 0 && assignPos > listenerPos)) {
  throw new Error("New image load listener must be installed before changing img.src")
}

if (script.includes("scheduleCoreWarmup()")) throw new Error("Core warmup regressed to delayed window-load scheduling")
const preparedShareStart = script.indexOf("function sharePreparedCard(fallbackMessage, method)")
const preparedShareEnd = script.indexOf('document.getElementById("webShareBtn")', preparedShareStart)
const preparedShareBlock = script.slice(preparedShareStart, preparedShareEnd)
if (preparedShareStart < 0 || preparedShareEnd < 0) throw new Error("Could not isolate first-click sharing")
if (preparedShareBlock.includes("ensurePreparedShareArtifact()")) throw new Error("Share must not gate first click on card preparation")
requireText('trackEvent("share_click", params)', "record every share attempt, even without a card")
requireText('outcome === "success"', "successful share outcome")
requireText('err.name === "AbortError" ? "cancel" : "error"', "separate cancellation from failure")
if (!index.includes('id="resultDetails"')) throw new Error("Missing findable optional analysis details")
if (preparedShareBlock.includes("await captureShareCard") || preparedShareBlock.includes("canvas.toBlob")) {
  throw new Error("Share click path must not perform expensive card rendering before navigator.share")
}
if (!index.includes('css/style.css?v=20261009-bottom1')) throw new Error("Missing versioned result CSS URL")
if (!index.includes('<div id="averageResult"></div>')) throw new Error("Result host must be a block container")
if (!index.includes('class="result-actions"')) throw new Error("Result controls must be grouped for shared spacing")

console.log("PASS runtime contract: immediate processing feedback, stable repeat-analysis loader, top-aligned result state, reset geometry, bounded detection retry, deduped warmup, exclusive outcome")
