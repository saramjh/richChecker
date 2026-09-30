// script.js가 실행되기 시작했다는 것 자체가 "이제부터 클릭이 실제로 동작한다"는 뜻이므로,
// 가장 먼저(다른 어떤 로직보다도 앞서) 부팅 오버레이부터 걷어낸다.
document.getElementById("bootOverlay")?.remove()

// GA4 커스텀 이벤트는 퍼널을 보되 제품 동작에는 절대 영향을 주지 않아야 한다.
// same-origin referrer만 의미 있는 내부 유입원으로 분류하고 외부 URL 자체는 수집하지 않는다.
function classifyEntryReferrer() {
	if (!document.referrer) return "direct"
	try {
		const ref = new URL(document.referrer)
		if (ref.origin !== location.origin) return "external"
		if (ref.pathname.startsWith("/rich-tester/")) return "rich-tester"
		if (ref.pathname.startsWith("/rich-face-test/")) return "rich-face-test"
		if (ref.pathname.startsWith("/billionaire-lookalike-test/")) return "billionaire-lookalike-test"
		if (ref.pathname.startsWith("/richChecker-us/")) return "edition-global"
		if (ref.pathname.startsWith("/richChecker/")) return "edition-korea"
		return "internal-other"
	} catch {
		return "unknown"
	}
}

const entryReferrer = classifyEntryReferrer()

function parseSharedChallengeParams() {
	const params = new URLSearchParams(window.location.search)
	if (params.get("via") !== "share") return null
	const matchId = params.get("match") || ""
	const score = Number.parseInt(params.get("score") || "", 10)
	if (!/^[a-z0-9-]{1,80}$/.test(matchId) || !Number.isInteger(score) || score < 3 || score > 100) return null
	return { matchId, score }
}

const sharedEntryCandidate = parseSharedChallengeParams()
let entryContext = sharedEntryCandidate ? "shared_candidate" : "standard"

function trackEvent(name, params = {}) {
	try {
		if (typeof gtag === "function") gtag("event", name, { entry_ref: entryReferrer, entry_context: entryContext, ...params })
	} catch (err) {
		console.warn("Analytics event skipped:", name, err)
	}
}

trackEvent("app_entry")

document.querySelectorAll("[data-edition-link]").forEach((link) => {
	link.addEventListener("click", () => {
		trackEvent("cross_edition_click", {
			placement: link.dataset.placement || "unknown",
			target_edition: link.dataset.targetEdition || "unknown",
			link_url: link.href,
		})
	})
})

let analysisAttemptCounter = 0

const MOTION = Object.freeze({
	resultOpacity: 0.24,
	resultTransform: 0.46,
	detailEnter: 0.28,
	radarEnter: 0.36,
	resetEnter: 0.34,
	loaderContentEnter: 0.28,
	loaderContentExit: 0.16,
	loaderSurfaceExit: 0.22,
	stagger: 0.035,
	easeOut: "power3.out",
	easeIn: "power2.in",
})

function prefersReducedMotion() {
	return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
}

// ===== 효과음 (Tone.js로 직접 합성 — 외부 음원 파일 없이 저작권 이슈 없이 재생) =====
let sfx = null
async function ensureSfx() {
	if (sfx) return sfx
	if (typeof Tone === "undefined") return null
	await Tone.start()
	sfx = {
		click: new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 2, volume: -18 }).toDestination(),
		chime: new Tone.PolySynth(Tone.FMSynth, { volume: -10 }).toDestination(),
	}
	return sfx
}

function playClick() {
	if (!sfx) return
	sfx.click.triggerAttackRelease("C2", "32n")
}

function playChime() {
	if (!sfx) return
	sfx.chime.triggerAttackRelease(["C5", "E5", "G5"], "8n")
}

// MediaPipe FaceLandmarker + faceFeatures.js는 ESM이라 동적 import로 로드.
// idle warmup과 즉시 분석이 겹쳐도 같은 import를 한 번만 수행한다.
let mediapipeModules = null
let mediapipeModulesPromise = null
async function ensureMediapipeModules() {
	if (mediapipeModules) return mediapipeModules
	if (!mediapipeModulesPromise) {
		mediapipeModulesPromise = Promise.all([
			import("./vendor/mediapipe/vision_bundle.mjs"),
			import("./faceFeatures.js"),
			import("./matchMath.js"),
		])
			.then(([vision, features, matchMath]) => {
				mediapipeModules = { ...vision, ...features, ...matchMath }
				return mediapipeModules
			})
			.catch((err) => {
				mediapipeModulesPromise = null
				throw err
			})
	}
	return mediapipeModulesPromise
}

// 공유 카드와 네이티브 공유 문구에 현재 결과를 넣기 위해 마지막 결과의 최소 요약만 유지한다.
let lastResultSummary = null

// populateShareCard()가 진행 중인 마지막 Promise — captureShareCard()가 캡처 전에 기다린다
// (사진 비율 보정을 위한 캔버스 크롭이 비동기라 생긴 경쟁 상태를 막기 위함).
let shareCardReadyPromise = null
let preparedShareBlob = null
let shareArtifactPromise = null
let shareResultGeneration = 0
let shareArtifactVersion = 0

function invalidateShareArtifact() {
	shareArtifactVersion += 1
	preparedShareBlob = null
	shareArtifactPromise = null
}

// 저장/공유 시 내 얼굴이 그대로 나가는 게 부담스러울 수 있다는 피드백 — 매칭 카드와 공유용
// 카드 양쪽의 "나" 사진에 블러를 걸지 여부. 새 결과가 렌더될 때도 이 선택을 유지한다
// (한 세션 안에서 여러 번 테스트해도 매번 다시 켤 필요가 없도록).
let faceHidden = false

function applyFaceHiddenState() {
	const topMatchUserImg = document.querySelector("#topMatchPhotos .topMatch-photo-box:first-child img")
	const shareCardUserImg = document.getElementById("shareCardUserPhoto")
	if (topMatchUserImg) topMatchUserImg.classList.toggle("face-hidden", faceHidden)
	if (shareCardUserImg) shareCardUserImg.classList.toggle("face-hidden", faceHidden)
	const toggleBtn = document.getElementById("faceHideToggle")
	if (toggleBtn) toggleBtn.setAttribute("aria-pressed", String(faceHidden))
	const toggleLabel = document.getElementById("faceHideToggleLabel")
	if (toggleLabel) toggleLabel.textContent = faceHidden ? "얼굴 가려짐 (다시 보이기)" : "공유 시 내 얼굴 가리기"
}

document.getElementById("faceHideToggle").addEventListener("click", function () {
	playClick()
	faceHidden = !faceHidden
	applyFaceHiddenState()
	invalidateShareArtifact()
	if (lastResultSummary) scheduleShareArtifactPreparation()
})

let faceLandmarkerInstance = null
let faceLandmarkerPromise = null
async function ensureFaceLandmarker() {
	if (faceLandmarkerInstance) return faceLandmarkerInstance
	if (!faceLandmarkerPromise) {
		faceLandmarkerPromise = (async () => {
			const { FaceLandmarker, FilesetResolver } = await ensureMediapipeModules()
			const fileset = await FilesetResolver.forVisionTasks("./js/vendor/mediapipe/wasm")
			return FaceLandmarker.createFromOptions(fileset, {
				baseOptions: { modelAssetPath: "./models/mediapipe/face_landmarker.task", delegate: "CPU" },
				outputFaceBlendshapes: true,
				runningMode: "IMAGE",
				numFaces: 1,
			})
		})()
			.then((instance) => {
				faceLandmarkerInstance = instance
				return instance
			})
			.catch((err) => {
				faceLandmarkerPromise = null
				throw err
			})
	}
	return faceLandmarkerPromise
}

let coreWarmupPromise = null
function startCoreWarmup(reason = "startup") {
	if (coreWarmupPromise) return coreWarmupPromise
	const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
	if (reason === "startup" && connection && connection.saveData) return Promise.resolve([])
	const startedAt = performance.now()
	coreWarmupPromise = Promise.allSettled([ensureFaceLandmarker(), loadEmbeddings()]).then((results) => {
		if (results.some((result) => result.status === "rejected")) coreWarmupPromise = null
		trackEvent("core_warmup_complete", {
			reason,
			elapsed_ms: Math.round(performance.now() - startedAt),
			model_ready: faceLandmarkerInstance ? 1 : 0,
			data_ready: embeddingsReady ? 1 : 0,
		})
		return results
	})
	return coreWarmupPromise
}


function topExpressionFromBlendshapes(categories) {
	const score = (...names) => {
		const vals = names.map((n) => categories.find((c) => c.categoryName === n)?.score || 0)
		return vals.reduce((a, b) => a + b, 0) / vals.length
	}
	const candidates = {
		행복: score("mouthSmileLeft", "mouthSmileRight"),
		놀람: score("eyeWideLeft", "eyeWideRight", "jawOpen"),
		화남: score("browDownLeft", "browDownRight"),
		슬픔: score("mouthFrownLeft", "mouthFrownRight"),
	}
	const [label, topScore] = Object.entries(candidates).reduce((best, cur) => (cur[1] > best[1] ? cur : best))
	// 실측해보니 진짜 무표정 사진은 모든 항목이 0.02 근처였고, 뚜렷한 미소도 0.35 정도였다.
	// 예전 기준(0.15)은 그 사이 애매한 지점이라, 활짝 웃지 않고 은은하게 웃는(입을 다물고
	// 웃는 등) 흔한 사진들까지 "무표정"으로 오판했다 — 진짜 무표정의 노이즈 수준(~0.02)보다
	// 확실히 높으면서 절반 정도 강도의 미소도 잡아내도록 기준을 낮췄다.
	if (topScore < 0.06) return { label: "무표정", score: 1 - topScore }
	return { label, score: topScore }
}

// 초기 placeholder는 index.html의 <img src>가 소유한다.
// load 시점에 src를 다시 쓰면 첫 방문에서 사용자가 고른 사진을 뒤늦은 window load가
// placeholder로 덮어써 첫 분석만 face_not_detected가 되는 레이스가 생긴다.

// 이미지와 명시적 CTA가 같은 파일 선택 흐름을 사용한다. 어느 진입점이 실제 선택으로
// 이어지는지 측정해 첫 화면의 기능 접근성을 검증한다.
let lastPhotoPickerSource = "unknown"
function openPhotoPicker(source = "unknown") {
	lastPhotoPickerSource = source
	trackEvent("photo_picker_opened", { source })
	startCoreWarmup("photo_intent")
	ensureSfx().then(playClick)
	document.getElementById("uploadImage").click()
}

document.getElementById("uploadedImage").addEventListener("click", () => openPhotoPicker("upload_panel"))
document.getElementById("choosePhotoBtn").addEventListener("click", () => openPhotoPicker("primary_cta"))

document.getElementById("uploadedImage").addEventListener("keydown", (event) => {
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault()
		openPhotoPicker("upload_panel_keyboard")
	}
})

// 위 리스너를 붙이는 줄이 실행됐다는 건 이 시점부터 클릭이 실제로 동작한다는 뜻이므로,
// 그제서야 "초기화 중" 표시를 걷어낸다. index.html에서 모든 외부 스크립트를 defer로 바꾸고
// script.js를 맨 마지막에 두었기 때문에, 이 줄이 실행되는 시점엔 GSAP/Tone 등
// 의존 라이브러리도 이미 전부 로드가 끝나 있다.
document.getElementById("uploadedImageContainer").classList.remove("is-initializing")

// 이미지가 실제 픽셀 크기까지 준비되기 전에 MediaPipe를 시작하면 느린 모바일에서
// naturalWidth/Height가 0인 캔버스가 만들어질 수 있다. src 설정 후 decode/load 완료를 보장한다.
function setImageSourceAndWait(img, src) {
	return new Promise((resolve, reject) => {
		let settled = false
		const cleanup = () => {
			img.removeEventListener("load", onLoad)
			img.removeEventListener("error", onError)
		}
		const finish = (error) => {
			if (settled) return
			settled = true
			cleanup()
			if (error) reject(error)
			else if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve()
			else reject(new Error("Image has no decodable pixels"))
		}
		const onLoad = () => finish()
		const onError = () => finish(new Error("Image decode failed"))

		// placeholder가 이미 complete인 상태를 새 사진의 준비 완료로 오인하지 않도록
		// 반드시 새 src를 넣기 전에 그 새 리소스의 load/error를 기다린다.
		img.addEventListener("load", onLoad)
		img.addEventListener("error", onError)
		img.src = src
	})
}


// 이미지 업로드 시 처리. 이전 분석의 finally/전환 애니메이션이 끝나기 전에 다음 분석이
// DOM을 건드리지 않도록 직렬화한다. 실패 직후 같은 사진을 빠르게 다시 골라도 상태가 섞이지 않는다.
let uploadTaskChain = Promise.resolve()
function waitForUiPaint() {
	return new Promise((resolve) => {
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve())
		else setTimeout(resolve, 16)
	})
}
document.getElementById("uploadImage").addEventListener("change", function () {
	const file = this.files[0]
	if (!file) return
	this.value = ""

	const source = lastPhotoPickerSource
	const fileSizeKb = Math.round(file.size / 1024)
	const loadingSessionId = showLoadingModal()
	trackEvent("upload_started", { source, file_size_kb: fileSizeKb })
	trackSharedVisitUpload()
	const readerStartedAt = performance.now()
	const reader = new FileReader()

	reader.onerror = async function () {
		trackEvent("upload_error", { error_type: "file_read", source, file_size_kb: fileSizeKb })
		await hideLoadingModal(loadingSessionId)
		showToast("사진 파일을 읽지 못했습니다. 다른 사진으로 다시 시도해주세요.")
	}

	reader.onload = function (e) {
		const readerReadyAt = performance.now()
		const fileReadMs = Math.round(readerReadyAt - readerStartedAt)
		const dataUrl = e.target.result
		uploadTaskChain = uploadTaskChain.catch(() => {}).then(async () => {
			await waitForUiPaint()
			const uploadedImage = document.getElementById("uploadedImage")
			uploadedImage.style.display = "block"
			document.getElementById("uploadedImageContainer").classList.add("has-photo")
			clearResults()

			const imageReadyStartedAt = performance.now()
			try {
				await setImageSourceAndWait(uploadedImage, dataUrl)
			} catch (err) {
				console.error(err)
				trackEvent("upload_error", {
					error_type: "image_decode",
					source,
					file_size_kb: fileSizeKb,
					file_read_ms: fileReadMs,
				})
				await hideLoadingModal(loadingSessionId)
				showToast("사진을 표시할 수 없습니다. JPG, PNG 또는 WebP 사진으로 다시 시도해주세요.")
				return
			}

			const imageReadyMs = Math.round(performance.now() - imageReadyStartedAt)
			const imageMegapixels = Math.round((uploadedImage.naturalWidth * uploadedImage.naturalHeight) / 10000) / 100
			await processImage({
				source,
				file_size_kb: fileSizeKb,
				file_read_ms: fileReadMs,
				image_ready_ms: imageReadyMs,
				image_megapixels: imageMegapixels,
			}, loadingSessionId)
		})
	}
	reader.readAsDataURL(file)
})

// data/embeddings.json: tools/precompute.html(MediaPipe 기반)로 미리 계산해둔
// { featureKeys, stats: {mean, std}, people: [{..., features}] } 구조.
// 성별 구분 없이 전체 인물 표본 하나로 통합 (여성 표본이 너무 적어 따로 나누는 의미가 없음).
let embeddingsPromise = null
let embeddingsReady = false
async function loadEmbeddings() {
	if (!embeddingsPromise) {
		embeddingsPromise = fetch("data/embeddings.json")
			.then((res) => {
				if (!res.ok) throw new Error("비교 데이터를 불러오지 못했습니다.")
				return res.json()
			})
			.then((data) => {
				if (!data || !Array.isArray(data.people) || data.people.length === 0) {
					throw new Error("비교 데이터가 비어 있습니다.")
				}
				embeddingsReady = true
				return data
			})
			.catch((err) => {
				embeddingsPromise = null
				embeddingsReady = false
				throw err
			})
	}
	return embeddingsPromise
}

// embeddings state is initialized above; startup warmup is now safe to begin.
startCoreWarmup("startup")

let sharedChallenge = null
let sharedVisitUploadTracked = false
let sharedVisitCompleteTracked = false
async function hydrateSharedChallenge() {
	if (!sharedEntryCandidate) return null
	try {
		const data = await loadEmbeddings()
		const person = data.people.find((candidate) => candidate.id === sharedEntryCandidate.matchId)
		if (!person) return null
		sharedChallenge = { matchId: person.id, matchName: person.name, score: sharedEntryCandidate.score }
		entryContext = "shared_result"
		const challengeEl = document.getElementById("challengeEntry")
		document.getElementById("challengeMatchName").textContent = person.name
		document.getElementById("challengeMatchScore").textContent = String(sharedEntryCandidate.score)
		challengeEl.hidden = false
		trackEvent("shared_visit", { shared_match_id: person.id, shared_score: sharedEntryCandidate.score })
		return sharedChallenge
	} catch (err) {
		console.warn("공유 결과 문맥을 확인하지 못했습니다.", err)
		return null
	}
}
const sharedChallengePromise = hydrateSharedChallenge()

function trackSharedVisitUpload() {
	if (!sharedChallengePromise || sharedVisitUploadTracked) return
	sharedChallengePromise.then((challenge) => {
		if (!challenge || sharedVisitUploadTracked) return
		sharedVisitUploadTracked = true
		trackEvent("shared_visit_upload", { shared_match_id: challenge.matchId, shared_score: challenge.score })
	})
}

function trackSharedVisitComplete(topMatch) {
	if (!sharedChallengePromise || sharedVisitCompleteTracked) return
	sharedChallengePromise.then((challenge) => {
		if (!challenge || sharedVisitCompleteTracked) return
		sharedVisitCompleteTracked = true
		trackEvent("shared_visit_complete", {
			shared_match_id: challenge.matchId,
			shared_score: challenge.score,
			new_match_id: topMatch.id,
			new_score: topMatch.similarityDisplay,
			same_match: challenge.matchId === topMatch.id ? 1 : 0,
		})
	})
}

function toMatch(person, similarity, similarityDisplay) {
	return {
		id: person.id,
		name: person.name,
		title: person.title,
		image: person.image, // 공유 카드에서 "나 vs 매칭 인물" 사진 비교에 사용
		rank: person.rank,
		netWorth: person.netWorth,
		achievement: person.achievement,
		credit: person.credit,
		isIllustration: person.isIllustration,
		features: person.features,
		similarity,
		similarityDisplay,
	}
}

// 휴대폰 카메라 사진은 보통 EXIF 방향 태그가 붙어 있다 — <img>는 화면에 그릴 때 이 태그를
// 적용해 똑바로 보여주지만, 일부 브라우저의 라이브러리 내부 디코딩 경로(예: createImageBitmap)는
// 이 태그를 무시해서 "화면엔 똑바로 보이는데 분석기엔 옆으로 누운 얼굴"이 들어가 얼굴을 못 찾는
// 경우가 있다. <img>를 캔버스에 한 번 그려서 넘기면 화면에 보이는 것과 완전히 같은(방향 보정된)
// 픽셀을 분석기에 넘기게 된다. 카메라 원본은 해상도가 매우 커서(4000px+) 적당히 줄여 속도도 안정화.
// maxDim은 "휴대폰 카메라 원본(보통 3000px+)만 줄이자"가 목표 — 사전계산에 쓰인 큐레이션된
// 재벌 표본 사진(위키/뉴스 사진, 대체로 2000px 이하)까지 건드리면, 그 인물의 사진을 다시
// 업로드했을 때 사전계산 시점과 실시간 분석 시점의 입력 해상도가 달라져 랜드마크가 미세하게
// 어긋나고 "자기 자신인데 100%가 안 나온다"는 오차가 생긴다.
function toDetectionCanvas(imgEl, maxDim = 2200) {
	const scale = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight))
	const canvas = document.createElement("canvas")
	canvas.width = Math.round(imgEl.naturalWidth * scale)
	canvas.height = Math.round(imgEl.naturalHeight * scale)
	canvas.getContext("2d").drawImage(imgEl, 0, 0, canvas.width, canvas.height)
	return canvas
}

function resizeDetectionCanvas(sourceCanvas, maxDim) {
	const scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height))
	if (scale === 1) return sourceCanvas
	const canvas = document.createElement("canvas")
	canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale))
	canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale))
	canvas.getContext("2d").drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height)
	return canvas
}

async function detectFaceWithRetry(landmarker, initialCanvas) {
	const attempts = [initialCanvas]
	const fallbackCanvas = resizeDetectionCanvas(initialCanvas, 1280)
	if (fallbackCanvas !== initialCanvas) attempts.push(fallbackCanvas)
	else attempts.push(initialCanvas)

	for (let i = 0; i < attempts.length; i += 1) {
		if (i > 0) await new Promise((resolve) => setTimeout(resolve, 16))
		const canvas = attempts[i]
		const detection = landmarker.detect(canvas)
		if (detection.faceLandmarks && detection.faceLandmarks[0]) {
			return { detection, canvas, attempts: i + 1 }
		}
	}
	return { detection: null, canvas: attempts[attempts.length - 1], attempts: attempts.length }
}

async function processImage(context = {}, loadingSessionId = null) {
	const startedAt = performance.now()
	const attemptNumber = ++analysisAttemptCounter
	const modelWarm = Boolean(faceLandmarkerInstance)
	const dataWarm = embeddingsReady
	let stage = "start"
	let outcomeTracked = false
	const timings = {}
	const eventParams = (extra = {}) => ({
		attempt_number: attemptNumber,
		source: context.source || "unknown",
		elapsed_ms: Math.round(performance.now() - startedAt),
		model_warm: modelWarm ? 1 : 0,
		data_warm: dataWarm ? 1 : 0,
		...context,
		...timings,
		...extra,
	})
	const fail = (errorType, message, err) => {
		if (outcomeTracked) return
		outcomeTracked = true
		if (err) console.error(err)
		trackEvent("analysis_error", eventParams({ error_type: errorType, stage }))
		showToast(message)
	}
	const timed = async (name, task) => {
		const phaseStartedAt = performance.now()
		try {
			return await task()
		} finally {
			timings[name + "_ms"] = Math.round(performance.now() - phaseStartedAt)
		}
	}

	// 업로드 직후 준비된 픽셀을 첫 await 전에 고정한다. 모델/WASM 초기화 중 DOM의
	// <img> src가 바뀌더라도 이번 분석은 사용자가 선택한 바로 그 사진을 계속 사용해야 한다.
	const detectionCanvas = toDetectionCanvas(document.getElementById("uploadedImage"))

	const activeLoadingSessionId = loadingSessionId || showLoadingModal()
	trackEvent("analysis_started", eventParams())

	try {
		let modules
		stage = "module_load"
		try {
			modules = await timed("modules_ready", () => ensureMediapipeModules())
		} catch (err) {
			fail("module_load", "얼굴 인식 모듈을 불러오지 못했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.", err)
			return
		}
		const { computeFeatures, FEATURE_KEYS, FEATURE_LABELS, zscoreDistance, zscoreToPercentile, similarityFromDistance, displaySimilarity } = modules

		let landmarker
		stage = "model_load"
		try {
			landmarker = await timed("model_ready", () => ensureFaceLandmarker())
		} catch (err) {
			fail("model_load", "얼굴 인식 모델을 불러오지 못했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.", err)
			return
		}

		stage = "detect"
		const detectionStartedAt = performance.now()
		const detectionResult = await detectFaceWithRetry(landmarker, detectionCanvas)
		const detection = detectionResult.detection
		const analyzedCanvas = detectionResult.canvas
		timings.detection_ms = Math.round(performance.now() - detectionStartedAt)
		timings.detection_attempts = detectionResult.attempts
		const landmarks = detection && detection.faceLandmarks && detection.faceLandmarks[0]
		if (!landmarks) {
			fail("face_not_detected", "얼굴을 정확히 인식하지 못했습니다. 정면을 향한 밝은 사진으로 다시 시도해주세요.")
			return
		}

		stage = "match"
		const matchingStartedAt = performance.now()
		const featureObj = computeFeatures(landmarks, analyzedCanvas.width, analyzedCanvas.height)
		const uploadedFeatures = FEATURE_KEYS.map((key) => featureObj[key])

		let embeddingsData
		stage = "data_load"
		try {
			embeddingsData = await timed("data_ready", () => loadEmbeddings())
		} catch (err) {
			fail("embeddings_load", "표본 데이터를 불러오지 못했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.", err)
			return
		}

		const blendshapeCategories = detection.faceBlendshapes && detection.faceBlendshapes[0] && detection.faceBlendshapes[0].categories
		const expression = blendshapeCategories ? topExpressionFromBlendshapes(blendshapeCategories) : null

		const percentiles = (features) =>
			FEATURE_KEYS.map((key, i) => zscoreToPercentile(features[i], embeddingsData.stats.mean[i], embeddingsData.stats.std[i]))
		const userPercentiles = percentiles(uploadedFeatures)
		const namedPeople = embeddingsData.people.filter((person) => person.name)
		if (!namedPeople.length) throw new Error("비교할 부자 표본이 없습니다.")

		const nearestByFeature = FEATURE_KEYS.map((_, i) => {
			const userZ = (uploadedFeatures[i] - embeddingsData.stats.mean[i]) / embeddingsData.stats.std[i]
			return namedPeople.reduce(
				(best, person) => {
					const personZ = (person.features[i] - embeddingsData.stats.mean[i]) / embeddingsData.stats.std[i]
					const distance = Math.abs(userZ - personZ)
					return !best || distance < best.distance ? { person, distance } : best
				},
				null,
			).person
		})

		// "누구와 가장 닮았나"는 전체 6개 얼굴 비율 거리로 순위를 정한다.
		const overallMatches = namedPeople
			.map((person) => ({
				person,
				distance: zscoreDistance(uploadedFeatures, person.features, embeddingsData.stats),
			}))
			.sort((left, right) => left.distance - right.distance)
			.slice(0, 3)
			.map((item) => {
				const rawSimilarity = similarityFromDistance(item.distance)
				return toMatch(item.person, rawSimilarity, displaySimilarity(rawSimilarity))
			})

		const topMatch = overallMatches[0]
		const radarForArchetype = {
			keys: FEATURE_KEYS,
			labels: FEATURE_KEYS.map((key) => FEATURE_LABELS[key]),
			user: userPercentiles,
		}
		const archetype = computeArchetype(radarForArchetype)
		const dominantIdx = FEATURE_KEYS.indexOf(archetype.featureKey)
		const standoutPerson = nearestByFeature[dominantIdx]
		const standoutDistance = zscoreDistance(uploadedFeatures, standoutPerson.features, embeddingsData.stats)
		const standoutRawSimilarity = similarityFromDistance(standoutDistance)
		const standoutMatch = toMatch(standoutPerson, standoutRawSimilarity, displaySimilarity(standoutRawSimilarity))

		const radar = {
			keys: FEATURE_KEYS,
			labels: FEATURE_KEYS.map((key) => FEATURE_LABELS[key]),
			user: userPercentiles,
			match: percentiles(topMatch.features),
			matchLabel: topMatch.name,
			nearestByFeature,
		}
		timings.matching_ms = Math.round(performance.now() - matchingStartedAt)

		stage = "render"
		const renderStartedAt = performance.now()
		renderResults({ expression }, radar, archetype, overallMatches, standoutMatch)
		timings.render_ms = Math.round(performance.now() - renderStartedAt)

		// 완료는 결과 UI까지 실제 생성된 뒤에만 기록한다. renderResults가 실패하면
		// 같은 시도에 complete와 error가 동시에 찍히지 않는다.
		stage = "complete"
		outcomeTracked = true
		trackEvent("analysis_complete", eventParams({
			match_name: topMatch.name,
			standout_match_name: standoutMatch.name,
			archetype_name: archetype.name,
			similarity: topMatch.similarityDisplay,
		}))
		trackSharedVisitComplete(topMatch)
	} catch (err) {
		fail("unknown", "분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.", err)
	} finally {
		const resultsVisible = document.getElementById("resultsContainer").style.display !== "none"
		if (resultsVisible) window.scrollTo({ top: 0, left: 0, behavior: "auto" })
		await hideLoadingModal(activeLoadingSessionId)
		if (resultsVisible) revealRenderedResults()
		else if (typeof gsap !== "undefined") gsap.set(["#introSection", "#uploadedImageContainer"], { clearProps: "transform,opacity" })
	}
}

// Lucide 아이콘(MIT) 경로를 그대로 인라인해서 쓴다 — 이모지는 OS/브라우저마다 렌더링이
// 다 달라서(그리고 장식적이라) 제품 아이콘으로는 안 어울린다는 피드백 반영.
const ICON_PATHS = {
	brain:
		'<path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/>',
	eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
	gem: '<path d="M10.5 3 8 9l4 13 4-13-2.5-6"/><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"/><path d="M2 9h20"/>',
	smile: '<path d="M15 10V9"/><path d="M16.472 15a6 6 0 0 1-8.943 0"/><path d="M9 10V9"/><circle cx="12" cy="12" r="10"/>',
	shieldCheck:
		'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
	squareUser: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7 21v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/>',
	circleAlert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
	info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
	eyeOff:
		'<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
}

function icon(name, className = "trait-icon") {
	return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`
}

// alert()/confirm()은 브라우저 기본 UI라 테마가 완전히 깨져서(어두운 점성술 카드 한복판에
// 흰 배경의 OS 네이티브 팝업이 튀어나옴), 대신 테마에 맞는 토스트로 대체한다.
let toastTimer = null
function showToast(message) {
	const el = document.getElementById("toast")
	if (!el) return
	el.innerHTML = `${icon("circleAlert", "toast-icon")}<span>${message}</span>`
	el.classList.add("show")
	clearTimeout(toastTimer)
	if (typeof gsap !== "undefined") {
		gsap.killTweensOf(el)
		gsap.fromTo(el, { y: -16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "power2.out" })
	} else {
		el.style.opacity = "1"
	}
	toastTimer = setTimeout(hideToast, 4200)
}

function hideToast() {
	const el = document.getElementById("toast")
	if (!el || !el.classList.contains("show")) return
	clearTimeout(toastTimer)
	if (typeof gsap !== "undefined") {
		gsap.killTweensOf(el)
		gsap.to(el, { y: -16, opacity: 0, duration: 0.25, ease: "power1.in", onComplete: () => el.classList.remove("show") })
	} else {
		el.style.opacity = "0"
		el.classList.remove("show")
	}
}
document.getElementById("toast")?.addEventListener("click", hideToast)

// 마케팅 관점: "87.3%"라는 숫자 하나보다 "당신은 OO형입니다" 같은 정체성 라벨이 훨씬 잘
// 기억되고 공유된다(MBTI·각종 성향 테스트가 검증한 패턴). 6개 항목 중 재벌 표본 평균(50%)에서
// 가장 크게 벗어난 항목 하나를 "이 사람을 가장 잘 설명하는 특징"으로 뽑아 유형명을 붙인다.
// 같은 항목이라도 높은 쪽/낮은 쪽 방향에 따라 서로 다른(둘 다 긍정적인) 유형으로 갈린다.
const ARCHETYPES = {
	foreheadRatio: {
		high: { name: "높은 이마형", desc: "이마 높이 비율이 표본 평균보다 큰 편입니다." },
		low: { name: "낮은 이마형", desc: "이마 높이 비율이 표본 평균보다 작은 편입니다." },
	},
	eyeSpacingRatio: {
		high: { name: "넓은 눈간격형", desc: "눈 사이 간격 비율이 표본 평균보다 큰 편입니다." },
		low: { name: "좁은 눈간격형", desc: "눈 사이 간격 비율이 표본 평균보다 작은 편입니다." },
	},
	noseLengthRatio: {
		high: { name: "긴 코비율형", desc: "코 길이 비율이 표본 평균보다 큰 편입니다." },
		low: { name: "짧은 코비율형", desc: "코 길이 비율이 표본 평균보다 작은 편입니다." },
	},
	mouthWidthRatio: {
		high: { name: "넓은 입비율형", desc: "입 너비 비율이 표본 평균보다 큰 편입니다." },
		low: { name: "좁은 입비율형", desc: "입 너비 비율이 표본 평균보다 작은 편입니다." },
	},
	jawRatio: {
		high: { name: "긴 하안부형", desc: "입 중앙에서 턱까지의 길이 비율이 표본 평균보다 큰 편입니다." },
		low: { name: "짧은 하안부형", desc: "입 중앙에서 턱까지의 길이 비율이 표본 평균보다 작은 편입니다." },
	},
	faceAspectRatio: {
		high: { name: "세로형 얼굴", desc: "얼굴 높이 대비 너비 비율이 표본 평균보다 큰 편입니다." },
		low: { name: "가로형 얼굴", desc: "얼굴 높이 대비 너비 비율이 표본 평균보다 작은 편입니다." },
	},
}
function computeArchetype(radar) {
	let bestIdx = 0
	let bestDeviation = -1
	radar.user.forEach((percentile, i) => {
		const deviation = Math.abs(percentile - 50)
		if (deviation > bestDeviation) {
			bestDeviation = deviation
			bestIdx = i
		}
	})
	const key = radar.keys[bestIdx]
	const percentile = radar.user[bestIdx]
	const tier = percentile >= 50 ? "high" : "low"
	const archetype = ARCHETYPES[key][tier]
	const rankText = "특징 점수 " + percentile + "/100 · 표본 기준점 50"
	return { name: archetype.name, desc: archetype.desc, featureKey: key, featureLabel: radar.labels[bestIdx], rankText }
}

// 전통 관상학의 오악/궁(宮) 개념을 빌려온 해석 문구.
// high/mid/low는 0~100 특징 점수 구간 기준.
const FEATURE_READINGS = {
	foreheadRatio: {
		icon: "brain",
		label: "이마 높이 · 초년궁(전통 관상)",
		tooltip: "이마 위쪽 랜드마크에서 두 눈 안쪽 중앙까지의 거리를 얼굴 높이로 나눈 값입니다. 전통 관상에서는 이마를 초년궁과 연결해 해석했지만, 이 서비스는 운이나 성격을 예측하지 않습니다.",
		high: "47인 표본 기준으로 이마 높이 비율이 큰 편입니다.",
		mid: "47인 표본의 중간 범위에 가까운 이마 높이 비율입니다.",
		low: "47인 표본 기준으로 이마 높이 비율이 작은 편입니다.",
	},
	eyeSpacingRatio: {
		icon: "eye",
		label: "눈 사이 간격 · 대인궁(전통 관상)",
		tooltip: "두 눈 안쪽 모서리 사이 거리를 얼굴 너비로 나눈 값입니다. 전통 관상에서는 눈 주변을 대인관계와 연결해 해석했지만, 이 서비스는 성격이나 대인관계를 판정하지 않습니다.",
		high: "47인 표본 기준으로 눈 사이 간격 비율이 큰 편입니다.",
		mid: "47인 표본의 중간 범위에 가까운 눈 사이 간격입니다.",
		low: "47인 표본 기준으로 눈 사이 간격 비율이 작은 편입니다.",
	},
	noseLengthRatio: {
		icon: "gem",
		label: "코 길이 · 재백궁(전통 관상)",
		tooltip: "코 시작점에서 코끝까지의 거리를 얼굴 높이로 나눈 값입니다. 전통 관상에서는 코를 재백궁과 연결했지만, 이 서비스는 재물이나 경제적 성공을 예측하지 않습니다.",
		high: "47인 표본 기준으로 코 길이 비율이 큰 편입니다.",
		mid: "47인 표본의 중간 범위에 가까운 코 길이 비율입니다.",
		low: "47인 표본 기준으로 코 길이 비율이 작은 편입니다.",
	},
	mouthWidthRatio: {
		icon: "smile",
		label: "입 너비 · 언변궁(전통 관상)",
		tooltip: "입 양쪽 모서리 사이 거리를 얼굴 너비로 나눈 값입니다. 전통 관상에서는 입을 말과 화술에 연결해 해석했지만, 이 서비스는 언변이나 성격을 판정하지 않습니다.",
		high: "47인 표본 기준으로 입 너비 비율이 큰 편입니다.",
		mid: "47인 표본의 중간 범위에 가까운 입 너비 비율입니다.",
		low: "47인 표본 기준으로 입 너비 비율이 작은 편입니다.",
	},
	jawRatio: {
		icon: "shieldCheck",
		label: "하안부 길이 · 말년궁(전통 관상)",
		tooltip: "입 중앙에서 턱끝까지의 거리를 얼굴 높이로 나눈 값입니다. 턱의 폭이나 각짐을 측정하는 값이 아닙니다. 전통 관상에서는 턱을 말년궁과 연결했지만, 이 서비스는 미래의 운을 예측하지 않습니다.",
		high: "47인 표본 기준으로 입에서 턱까지의 길이 비율이 큰 편입니다.",
		mid: "47인 표본의 중간 범위에 가까운 하안부 길이 비율입니다.",
		low: "47인 표본 기준으로 입에서 턱까지의 길이 비율이 작은 편입니다.",
	},
	faceAspectRatio: {
		icon: "squareUser",
		label: "얼굴 종횡비 · 얼굴형",
		tooltip: "얼굴 높이를 얼굴 너비로 나눈 값입니다. 값이 클수록 세로로 긴 비율, 작을수록 가로로 넓은 비율에 가깝습니다.",
		high: "47인 표본 기준으로 세로로 긴 얼굴 비율에 가깝습니다.",
		mid: "47인 표본의 중간 범위에 가까운 얼굴 종횡비입니다.",
		low: "47인 표본 기준으로 가로로 넓은 얼굴 비율에 가깝습니다.",
	},
}
function tierForPercentile(percentile) {
	if (percentile >= 66) return "high"
	if (percentile <= 33) return "low"
	return "mid"
}

function renderFeatureReadings(radar) {
	if (!radar) return ""
	const items = radar.keys
		.map((key, i) => {
			const reading = FEATURE_READINGS[key]
			if (!reading) return ""
			const percentile = radar.user[i]
			const tier = tierForPercentile(percentile)
			const nearest = radar.nearestByFeature && radar.nearestByFeature[i]
			// 막대(0~100 특징 점수)와 "OOO과 N% 일치" 배지는 서로 다른 계산
			// 내 위치, 후자는 가장 가까운 한 명과의 근접도)인데 둘 다 숫자%라 나란히 붙어있으면
			// 막대는 62% 찼는데 옆 글자는 91%라고 해서 "둘이 왜 다르냐"는 혼란을 줬다 — 각자
			// 무엇을 재는 숫자인지 눈에 보이는 캡션을 따로 붙이고, 줄도 분리한다.
			const percentileCaption = "특징 점수: " + percentile + "/100 · 표본 기준점: 50"
			const barHtml = `
				<div class="reading-bar-row">
					<span class="reading-bar-caption">${percentileCaption}</span>
					<div class="reading-bar">
						<div class="reading-bar-fill" style="width:${percentile}%"></div>
						<div class="reading-bar-marker"></div>
					</div>
				</div>
			`
			// "이 항목은 OOO 회장과 닮았다"는 게 통계적 비교보다 흥미롭다는 피드백 반영 — 포브스
			// 순위까지 박아서 임팩트를 주되, 위 막대와는 아예 다른 줄로 분리한다.
			// closeness(%)는 일부러 안 붙인다 — "이름이 공개된 47명 중 이 항목이 가장 가까운 한 명"을 찾는
			// 거라 거의 항상 높게 나오고(특히 표본에 이미 있는 인물의 사진을 올리면 당연히
			// 모든 항목에서 100%가 나온다), 바로 위 특징 점수 막대와 다른 계산이라 숫자가 서로
			// 어긋나 보여 "그래프랑 수치가 따로 논다"는 혼란을 줬다. 막대 하나만 정량적 근거로
			// 남기고, 매칭 인물 이름은 숫자 없는 순수 코멘트로만 붙인다. 이름만으론 누군지 바로
			// 안 떠오를 수 있어 작은 썸네일을 같이 붙인다.
			const matchHtml = nearest
				? `
					<div class="reading-match">
						<img class="reading-match-thumb" src="${nearest.image}" alt="${nearest.name}">
						<p>✦ <strong>${nearest.name}</strong>${nearest.rank ? `(포브스 ${nearest.rank}위)` : ""}과 가장 닮은 부위예요</p>
					</div>
				`
				: ""
			// 라벨("이마 · 초년운" 등)만 봐서는 정확히 뭘 측정한 비율인지 알기 어렵다는 점 —
			// 호버(데스크톱)/탭(터치)으로 여는 툴팁에 측정 기준을 설명한다. 버튼 클릭은
			// document의 위임 리스너(아래 setupReadingTooltips)가 처리한다.
			const tooltipHtml = reading.tooltip
				? `<button type="button" class="reading-info-btn" aria-label="${reading.label} 설명 보기">${icon("info", "reading-info-icon")}</button><span class="reading-tooltip">${reading.tooltip}</span>`
				: ""
			return `
				<div class="reading-item">
					<div class="reading-head">
						<span class="reading-label">${icon(reading.icon)}${reading.label}${tooltipHtml}</span>
					</div>
					${barHtml}
					${matchHtml}
					<p>${reading[tier]}</p>
				</div>
			`
		})
		.join("")

	// 항목 하나 안에 서로 다른 두 가지 정보(① 막대: 내 얼굴 부위가 재벌 표본 평균보다 큰지
	// 작은지 ② ✦ 매칭 인물: 그 부위와 가장 닮은 재벌이 누구인지)가 같이 있는데, 제목이
	// "재벌 표본과의 비교"처럼 뭉뚱그려져 있으면 "이게 내 얼굴 분석이야, 아니면 누구와
	// 닮았다는 거야?" 헷갈린다는 피드백 — 소제목에서 이 둘이 서로 다른 것임을 명시적으로
	// 풀어서 설명한다.
	return `
		<div id="readingScroll">
			<h4>부위별 상세 분석</h4>
			<div class="reading-legend">
				<span class="reading-legend-item"><strong>막대</strong> — 재벌 평균 대비 내 얼굴 크기</span>
				<span class="reading-legend-item"><strong>✦</strong> — 가장 닮은 재벌</span>
			</div>
			${items}
		</div>
	`
}

// 항목 설명 버튼(ⓘ)은 결과가 렌더될 때마다 DOM이 통째로 새로 생기므로, 개별 리스너 대신
// document에 한 번만 위임 리스너를 건다. 데스크톱은 CSS 호버로 열리지만, 터치 환경엔 호버가
// 없어 이 클릭 토글이 유일한 열기/닫기 수단이다 — 버튼 밖을 클릭하면 열려있던 툴팁을 닫는다.
document.addEventListener("click", (e) => {
	const btn = e.target.closest(".reading-info-btn")
	document.querySelectorAll(".reading-tooltip.show").forEach((el) => {
		if (!btn || el !== btn.nextElementSibling) el.classList.remove("show")
	})
	if (btn) {
		e.preventDefault()
		btn.nextElementSibling.classList.toggle("show")
	}
})

// 육각 레이더 차트를 인라인 SVG로 그린다. userScores/matchScores는 0~100 퍼센타일.
function renderRadarChart(labels, userScores, matchScores, matchLabel, tierLabel, tierDesc) {
	const size = 220
	const center = size / 2
	const radius = 78
	const angleStep = (Math.PI * 2) / labels.length
	const startAngle = -Math.PI / 2

	const pointAt = (score, i) => {
		const angle = startAngle + angleStep * i
		const r = (Math.max(0, Math.min(100, score)) / 100) * radius
		return [(center + r * Math.cos(angle)).toFixed(1), (center + r * Math.sin(angle)).toFixed(1)]
	}

	const rings = [0.25, 0.5, 0.75, 1]
		.map((f) => {
			const pts = labels
				.map((_, i) => {
					const angle = startAngle + angleStep * i
					return `${(center + radius * f * Math.cos(angle)).toFixed(1)},${(center + radius * f * Math.sin(angle)).toFixed(1)}`
				})
				.join(" ")
			return `<polygon points="${pts}" fill="none" stroke="#c9b458" stroke-width="0.5" opacity="0.3"/>`
		})
		.join("")

	const axisLines = labels
		.map((_, i) => {
			const angle = startAngle + angleStep * i
			const x = (center + radius * Math.cos(angle)).toFixed(1)
			const y = (center + radius * Math.sin(angle)).toFixed(1)
			return `<line x1="${center}" y1="${center}" x2="${x}" y2="${y}" stroke="#c9b458" stroke-width="0.5" opacity="0.4"/>`
		})
		.join("")

	const axisLabels = labels
		.map((label, i) => {
			const angle = startAngle + angleStep * i
			const lx = (center + (radius + 20) * Math.cos(angle)).toFixed(1)
			const ly = (center + (radius + 20) * Math.sin(angle)).toFixed(1)
			return `<text x="${lx}" y="${ly}" font-size="12" fill="#e8d9a0" text-anchor="middle" dominant-baseline="middle">${label}</text>`
		})
		.join("")

	const matchPolygon = matchScores ? `<polygon class="radar-poly" points="${labels.map((_, i) => pointAt(matchScores[i], i).join(",")).join(" ")}" fill="rgba(201,180,88,0.18)" stroke="#c9b458" stroke-width="1.5" stroke-dasharray="4,3" style="transform-origin:${center}px ${center}px"/>` : ""
	const userPolygon = `<polygon class="radar-poly" points="${labels.map((_, i) => pointAt(userScores[i], i).join(",")).join(" ")}" fill="rgba(255,90,90,0.28)" stroke="#ff5a5a" stroke-width="1.5" style="transform-origin:${center}px ${center}px"/>`

	// 등급 판정("눈에 띄는 특징" 등)은 예전엔 카드 위쪽에 별도 금색 박스로 떠 있어서 카드 안에
	// 박스가 또 있는 것처럼 스타일이 어긋나 보였다 — 박스 없는 이 안내문 자리에 자연스럽게
	// 얹는다. (모양이 삐죽삐죽한 이유를 설명하던 문장은 불필요하다는 피드백으로 제거함 —
	// 빨간/금색 선의 겹침으로 유사도를 보여주는 건 범례로 충분히 전달된다고 판단.)
	const shapeNote = matchScores && tierLabel ? `<p id="radarNote"><strong>${tierLabel}</strong> ${tierDesc}</p>` : ""

	return `
		<div id="radarChart">
			<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:220px">
				${rings}${axisLines}${matchPolygon}${userPolygon}${axisLabels}
			</svg>
			<div id="radarLegend"><span class="legend-user">● 나</span>${matchScores ? `<span class="legend-match">✦ ${matchLabel}</span>` : ""}</div>
			${shapeNote}
		</div>
	`
}

function renderTopMatch(match, radar, tierLabel, tierDesc) {
	const badges = []
	if (match.rank) badges.push(`<span class="badge">포브스 순위 ${match.rank}위</span>`)
	if (match.netWorth) badges.push(`<span class="badge">자산 ${match.netWorth}</span>`)

	const achievementHtml = match.achievement ? `<p id="topMatchAchievement">${match.achievement}</p>` : ""
	const creditHtml = match.credit
		? `<p id="topMatchCredit">사진 출처: <a href="${match.credit.source}" target="_blank" rel="noopener">${match.credit.author}</a> (${match.credit.license})</p>`
		: match.isIllustration
			? `<p id="topMatchCredit">AI가 상상으로 그린 캐리커쳐입니다 (실제 사진 아님)</p>`
			: ""
	// 등급 판정("눈에 띄는 특징" 등)은 예전엔 이 카드 맨 위에 별도 금색 박스로 떠서, 카드 안에
	// 박스가 또 있는 것처럼 스타일이 어긋나 보였다는 피드백 — 레이더 차트 아래 박스 없는
	// 안내문에 자연스럽게 얹는다(renderRadarChart 안에서 처리).
	const radarHtml = radar ? renderRadarChart(radar.labels, radar.user, radar.match, radar.matchLabel, tierLabel, tierDesc) : ""

	// "재벌 얼굴을 텍스트로만 말하지 말고 실제로 보여달라"는 피드백 반영 — 카드 안에 바로
	// "나 vs 매칭 인물" 사진을 나란히 놓는다(예전엔 저장용 공유 카드에만 있던 구성). 일치율
	// %는 사진 위 뱃지 대신 이 둘 사이 자리에 직접 박아서, "이 사진과 이 사진이 몇 % 닮았다"는
	// 뜻이 두 사진 사이 공간에서 바로 읽히게 한다(id는 카드 리빌 이후 카운트업 애니메이션 대상).
	// 얼굴 가리기 토글이 켜져 있으면 흐린 사진만 덩그러니 있는 게 아니라, 반투명 스크림 +
	// 아이콘으로 "의도적으로 가린 상태"임을 분명히 보여준다(applyFaceHiddenState가 .face-hidden
	// 클래스를 img에 붙이면 이 오버레이가 CSS로 자동 나타남).
	const userPhotoSrc = document.getElementById("uploadedImage").src
	const photosHtml = match.image
		? `
			<div id="topMatchPhotos">
				<div class="topMatch-photo-box">
					<div class="photo-frame">
						<img src="${userPhotoSrc}" alt="나">
						<div class="face-hidden-overlay">${icon("eyeOff", "face-hidden-icon")}<span>비공개</span></div>
					</div>
					<span>나</span>
				</div>
				<div class="topMatch-percent" id="topMatchPercent">${match.similarityDisplay}%</div>
				<div class="topMatch-photo-box"><img src="${match.image}" alt="${match.name}"><span>${match.name}</span></div>
			</div>
		`
		: ""

	return `
		<div id="topMatch">
			<div id="topMatchShine"></div>
			<div class="top-match-eyebrow">종합 얼굴 비율 1위</div>
			<div id="topMatchHeader">
				<span id="topMatchName">${match.name}</span>
			</div>
			${match.title ? `<div id="topMatchTitle">${match.title}</div>` : ""}
			${badges.length ? `<div id="topMatchBadges">${badges.join("")}</div>` : ""}
			${photosHtml}
			${radarHtml}
			${achievementHtml}
			${creditHtml}
		</div>
	`
}

function renderRunnerUps(matches) {
	if (!Array.isArray(matches) || matches.length < 2) return ""
	const rows = matches.slice(1, 3).map((match, index) => `
		<div class="runner-up-row">
			<span class="runner-up-position">#${index + 2}</span>
			<img src="${match.image}" alt="${match.name}">
			<span class="runner-up-copy">
				<span class="runner-up-name">${match.name}</span>
				${match.title ? `<span class="runner-up-title">${match.title}</span>` : ""}
			</span>
			<span class="runner-up-similarity">${match.similarityDisplay}%</span>
		</div>
	`).join("")
	return `<div class="runner-ups"><div class="runner-ups-heading">다음으로 가까운 매치</div>${rows}<div class="runner-ups-note">전체 6개 얼굴 비율 기준</div></div>`
}

function initializeResultAds() {
	if (["localhost", "127.0.0.1"].includes(location.hostname)) return
	const attempt = (remainingRetries) => {
		let waitingForLayout = false
		document.querySelectorAll("#resultsContainer .adsbygoogle").forEach((ins) => {
			if (ins.dataset.adsbygoogleStatus) return
			if (ins.getBoundingClientRect().width <= 0) {
				waitingForLayout = true
				return
			}
			try {
				(window.adsbygoogle = window.adsbygoogle || []).push({})
			} catch (err) {
				// 광고 네트워크/레이아웃 오류는 분석 결과를 실패로 바꾸면 안 된다.
				console.warn("Result ad initialization skipped:", err)
			}
		})
		if (waitingForLayout && remainingRetries > 0) {
			setTimeout(() => attempt(remainingRetries - 1), 250)
		}
	}

	requestAnimationFrame(() => setTimeout(() => attempt(2), 0))
}

function renderResults(aiInfo, radar, archetype, topMatches, standoutMatch) {
	const topMatch = topMatches[0]
	const topSimilarity = topMatch.similarityDisplay
	const readingHtml = renderFeatureReadings(radar)
	const runnerUpsHtml = renderRunnerUps(topMatches)

	const aiBadgeLines = []
	if (aiInfo && aiInfo.expression) aiBadgeLines.push(`<span class="ai-badge-line ai-badge-sub">${aiInfo.expression.label} ${(aiInfo.expression.score * 100).toFixed(0)}%</span>`)
	document.getElementById("aiInfoBadge").innerHTML = aiBadgeLines.join("")

	let tierLabel = ""
	if (topSimilarity >= 90) tierLabel = "매우 가까운 얼굴 비율"
	else if (topSimilarity >= 80) tierLabel = "강한 유사도"
	else if (topSimilarity >= 70) tierLabel = "비슷한 얼굴 비율"
	else if (topSimilarity >= 60) tierLabel = "공통점이 보이는 비율"
	else if (topSimilarity >= 50) tierLabel = "부분적으로 비슷함"
	else if (topSimilarity >= 40) tierLabel = "미묘한 유사도"
	else if (topSimilarity >= 30) tierLabel = "가벼운 유사도"
	else if (topSimilarity >= 20) tierLabel = "대체로 다른 비율"
	else if (topSimilarity >= 10) tierLabel = "뚜렷하게 다른 비율"
	else tierLabel = "독특한 얼굴 비율 조합"
	const tierDesc = "유사도는 1위 매치와 전체 6개 얼굴 비율을 비교한 값입니다."

	const topMatchHtml = `<div id="topMatchReveal" class="pending-reveal">${renderTopMatch(topMatch, radar, tierLabel, tierDesc)}</div>`
	const archetypeHtml = archetype
		? `
			<div id="archetypeBadge">
				<span id="archetypeEyebrow">내 두드러진 특징</span>
				<span id="archetypeName">${icon(FEATURE_READINGS[archetype.featureKey].icon, "archetype-icon")}${archetype.name}</span>
				<p id="archetypeDesc">${archetype.featureLabel} · ${archetype.rankText} — ${archetype.desc}<span class="standout-match">이 특징은 <strong>${standoutMatch.name}</strong>과 가장 가깝습니다.</span></p>
			</div>
		`
		: ""

	const divider = `<div class="section-divider"><span></span>✦<span></span></div>`
	document.getElementById("averageResult").innerHTML = `
		<div id="resultRate">
			${topMatchHtml}
			${runnerUpsHtml}
			${archetypeHtml ? divider + archetypeHtml : ""}
			${readingHtml ? divider + readingHtml : ""}
		</div>
	`

	const resultsEl = document.getElementById("resultsContainer")
	resultsEl.style.display = "block"
	resultsEl.style.opacity = "0"
	resultsEl.style.transform = "translateY(10px) scale(0.995)"
	document.body.classList.add("result-mode")
	document.getElementById("introSection").style.display = "none"
	document.getElementById("uploadedImageContainer").style.display = "none"

	const cardEl = document.getElementById("topMatch")
	if (cardEl) initHoloEffect(cardEl)

	const topSimilarityText = String(topSimilarity)
	lastResultSummary = { topMatchId: topMatch.id, topMatchName: topMatch.name, archetypeName: archetype && archetype.name, topSimilarity: topSimilarityText }
	shareCardReadyPromise = populateShareCard(topMatch, topSimilarityText, tierLabel, archetype, radar, shareResultGeneration)
	applyFaceHiddenState()
	initializeResultAds()
}

function revealRenderedResults() {
	const resultsEl = document.getElementById("resultsContainer")
	if (!resultsEl || resultsEl.style.display === "none") return
	const revealEl = document.getElementById("topMatchReveal")

	if (revealEl) revealEl.classList.add("revealed")
	if (prefersReducedMotion() || typeof gsap === "undefined") {
		resultsEl.style.opacity = "1"
		resultsEl.style.transform = "none"
		armShareArtifactPreparation()
		return
	}

	gsap.killTweensOf([resultsEl, ".reading-item", ".radar-poly"])
	const timeline = gsap.timeline({
		onComplete: () => gsap.set(resultsEl, { clearProps: "opacity,transform" }),
	})
	// Motion-style value-specific timing: opacity resolves quickly while position/scale settles more softly.
	timeline.to(resultsEl, { opacity: 1, duration: MOTION.resultOpacity, ease: "power1.out" }, 0)
	timeline.to(resultsEl, { y: 0, scale: 1, duration: MOTION.resultTransform, ease: MOTION.easeOut }, 0)
	timeline.from(".reading-item", {
		opacity: 0,
		y: 6,
		duration: MOTION.detailEnter,
		stagger: MOTION.stagger,
		ease: MOTION.easeOut,
	}, 0.10)
	timeline.fromTo(".radar-poly", { scale: 0.98, opacity: 0 }, {
		scale: 1,
		opacity: 1,
		duration: MOTION.radarEnter,
		stagger: 0.05,
		ease: MOTION.easeOut,
	}, 0.14)
	window.setTimeout(playChime, 170)
	armShareArtifactPreparation()
}

// html2canvas(1.4.1)는 <img>의 CSS object-fit을 반영하지 않고 원본 이미지를 그냥 박스
// 크기로 늘려버린다(실측: 옆에 여백을 붙인 테스트 이미지를 캡처해보니 여백이 잘리지 않고
// 66%나 그대로 늘어나 들어있었다) — "사진 비율이 늘어나 보인다"는 신고가 정확했다.
// 캡처 전에 목표 비율로 미리 중앙 크롭해두면, html2canvas가 어떻게 그리든 이미 올바른
// 비율의 픽셀이라 왜곡될 여지가 없어진다.
function cropImageToRatio(src, targetRatio) {
	return new Promise((resolve, reject) => {
		if (!src) {
			resolve("")
			return
		}
		const img = new Image()
		img.crossOrigin = "anonymous"
		img.onload = () => {
			const srcRatio = img.naturalWidth / img.naturalHeight
			let sx, sy, sw, sh
			if (srcRatio > targetRatio) {
				sh = img.naturalHeight
				sw = sh * targetRatio
				sx = (img.naturalWidth - sw) / 2
				sy = 0
			} else {
				sw = img.naturalWidth
				sh = sw / targetRatio
				sx = 0
				sy = (img.naturalHeight - sh) / 2
			}
			const canvas = document.createElement("canvas")
			canvas.width = 480
			canvas.height = Math.round(480 / targetRatio)
			canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
			resolve(canvas.toDataURL("image/jpeg", 0.92))
		}
		img.onerror = () => resolve(src) // 크롭 실패해도 원본이라도 보이는 편이 낫다
		img.src = src
	})
}

// 부위별 상세 분석 안의 "가장 닮은 부위" 원형 썸네일도 같은 html2canvas 한계에 걸린다 —
// renderFeatureReadings()가 만든 마크업을 그대로 넣은 뒤, 그 안의 썸네일들만 정사각형으로
// 다시 크롭해 원 안에 얼굴이 늘어나 보이지 않게 한다.
async function fixThumbnailAspectRatios(container) {
	const thumbs = container.querySelectorAll(".reading-match-thumb")
	await Promise.all(
		Array.from(thumbs).map(async (thumb) => {
			thumb.src = await cropImageToRatio(thumb.src, 1)
		}),
	)
}

// 인스타/페이스북/카카오톡에 공유하기 좋은 비율 카드(화면엔 안 보임, 캡처 전용)에 결과를
// 채워넣는다. "나 vs 매칭 인물" 사진 비교 + 육각 레이더 차트 + 부위별 상세 분석까지, 온페이지
// 결과와 같은 내용을 담아야 이미지만 보고도 "나도 해보고 싶다"는 마음이 들 만큼 정보가 된다.
async function populateShareCard(topMatch, topSimilarity, tierLabel, archetype, radar, generation = shareResultGeneration) {
	const userPhotoSrc = document.getElementById("uploadedImage").src
	// 사진 박스 CSS 비율(128:160)에 맞춰 미리 크롭 — 위 cropImageToRatio 주석 참고.
	const PHOTO_RATIO = 128 / 160
	const [userCropped, matchCropped] = await Promise.all([cropImageToRatio(userPhotoSrc, PHOTO_RATIO), cropImageToRatio(topMatch.image, PHOTO_RATIO)])
	if (generation !== shareResultGeneration) return false

	document.getElementById("shareCardUserPhoto").src = userCropped
	document.getElementById("shareCardPercent").textContent = topSimilarity + "%"
	// 캡처되는 카드에도 등급 문구뿐 아니라 유형 라벨을 같이 박아서, 이미지 자체가 "나는 OO형"
	// 이라는 정체성을 보여주는 공유용 콘텐츠가 되게 한다.
	document.getElementById("shareCardTier").textContent = archetype ? `${tierLabel} · ${archetype.name}` : tierLabel

	document.getElementById("shareCardMatchName").textContent = topMatch.name
	document.getElementById("shareCardMatchName2").textContent = topMatch.name
	document.getElementById("shareCardMatchPhoto").src = matchCropped

	const badges = []
	if (topMatch.rank) badges.push(`<span class="badge">포브스 ${topMatch.rank}위</span>`)
	if (topMatch.netWorth) badges.push(`<span class="badge">${topMatch.netWorth}</span>`)
	document.getElementById("shareCardBadges").innerHTML = badges.join("")

	// 저장한 이미지에 육각 레이더 차트가 안 담겨서 아쉽다는 피드백 — 온페이지 카드와 같은
	// 함수를 재사용한다. tierLabel/tierDesc는 넘기지 않아 등급 문구(#radarNote)는 이
	// 카드에선 생략(같은 내용이 #shareCardTier에 이미 있어 중복 방지).
	document.getElementById("shareCardRadar").innerHTML = renderRadarChart(radar.labels, radar.user, radar.match, radar.matchLabel)

	// "저장 이미지만 봐서는 이게 뭘 보여주는 결과인지 절반만 전달된다"는 피드백 — 온페이지와
	// 동일한 부위별 상세 분석을 그대로 포함한다(툴팁 버튼은 정적 이미지에선 그냥 장식이 되지만
	// 해로울 건 없다).
	const readingsEl = document.getElementById("shareCardReadings")
	readingsEl.innerHTML = renderFeatureReadings(radar)
	await fixThumbnailAspectRatios(readingsEl)
	return generation === shareResultGeneration
}

// 저장/공유 버튼이 공용으로 사용할 카드 캡처. 폭은 360px로 고정하지만 높이는 레이더 차트
// 포함 여부에 따라 내용물 기준으로 자연스럽게 늘어난다(el.offsetHeight로 실측) —
// scale:2.5로 캡처하면 실제 폭은 900px. 모바일 공유 파일 생성 지연을 줄이면서 텍스트 해상도를 유지한다.
async function captureShareCard() {
	if (shareCardReadyPromise) await shareCardReadyPromise
	const el = document.getElementById("shareCard")
	el.style.display = "flex"
	try {
		return await html2canvas(el, {
			width: el.offsetWidth,
			height: el.offsetHeight,
			scale: 2.5,
			useCORS: true,
			backgroundColor: null,
		})
	} finally {
		el.style.display = "none"
	}
}

async function prepareShareArtifact() {
	if (preparedShareBlob) return preparedShareBlob
	if (shareArtifactPromise) return shareArtifactPromise
	const resultGeneration = shareResultGeneration
	const artifactVersion = shareArtifactVersion
	shareArtifactPromise = (async () => {
		const canvas = await captureShareCard()
		const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
		if (!blob) throw new Error("Share card PNG encoding failed")
		if (resultGeneration !== shareResultGeneration || artifactVersion !== shareArtifactVersion) return null
		preparedShareBlob = blob
		return blob
	})().catch((err) => {
		if (resultGeneration === shareResultGeneration && artifactVersion === shareArtifactVersion) shareArtifactPromise = null
		throw err
	})
	return shareArtifactPromise
}

let sharePreparationObserver = null
let sharePreparationArmTimer = null
let sharePreparationTimer = null
let sharePreparationIdleId = null

function disconnectSharePreparationObserver() {
	if (sharePreparationObserver) sharePreparationObserver.disconnect()
	sharePreparationObserver = null
}

function cancelShareArtifactPreparation() {
	disconnectSharePreparationObserver()
	if (sharePreparationArmTimer) clearTimeout(sharePreparationArmTimer)
	if (sharePreparationTimer) clearTimeout(sharePreparationTimer)
	if (sharePreparationIdleId !== null && "cancelIdleCallback" in window) window.cancelIdleCallback(sharePreparationIdleId)
	sharePreparationArmTimer = null
	sharePreparationTimer = null
	sharePreparationIdleId = null
}

function scheduleShareArtifactPreparation(delayMs = 420) {
	if (preparedShareBlob || shareArtifactPromise) return
	if (sharePreparationTimer) clearTimeout(sharePreparationTimer)
	sharePreparationTimer = window.setTimeout(() => {
		sharePreparationTimer = null
		if (document.getElementById("resultsContainer").style.display === "none") return
		const prepare = () => {
			sharePreparationIdleId = null
			prepareShareArtifact().catch((err) => console.warn("Share card preparation failed:", err))
		}
		if ("requestIdleCallback" in window) {
			sharePreparationIdleId = window.requestIdleCallback(prepare, { timeout: 700 })
		} else {
			sharePreparationTimer = window.setTimeout(prepare, 60)
		}
	}, delayMs)
}

function armShareArtifactPreparation() {
	cancelShareArtifactPreparation()
	const target = document.querySelector(".result-actions")
	if (!target) return
	// Proximity only arms a cancellable delay. Fast scroll-to-reset never starts html2canvas,
	// while ordinary reading gives the share card enough lead time before the controls are tapped.
	sharePreparationArmTimer = window.setTimeout(() => {
		sharePreparationArmTimer = null
		if (document.getElementById("resultsContainer").style.display === "none") return
		if (!("IntersectionObserver" in window)) {
			scheduleShareArtifactPreparation(900)
			return
		}
		sharePreparationObserver = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return
			disconnectSharePreparationObserver()
			scheduleShareArtifactPreparation(420)
		}, { rootMargin: "560px 0px" })
		sharePreparationObserver.observe(target)
	}, 260)
}
// 마우스/터치 위치에 따라 카드가 기울어지고 무지개 시광이 움직이는 홀로그래픽 효과
function initHoloEffect(cardEl) {
	if (prefersReducedMotion()) return
	const shine = document.getElementById("topMatchShine")
	if (!shine) return

	const applyTilt = (clientX, clientY) => {
		const rect = cardEl.getBoundingClientRect()
		const x = (clientX - rect.left) / rect.width
		const y = (clientY - rect.top) / rect.height
		const rotateY = (x - 0.5) * 16
		const rotateX = (0.5 - y) * 16
		cardEl.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.015)`
		shine.style.backgroundPosition = `${x * 100}% ${y * 100}%`
		shine.style.opacity = "0.7"
	}

	const resetTilt = () => {
		cardEl.style.transform = ""
		shine.style.opacity = "0"
	}

	cardEl.addEventListener("mousemove", (e) => applyTilt(e.clientX, e.clientY))
	cardEl.addEventListener("mouseleave", resetTilt)
	cardEl.addEventListener(
		"touchmove",
		(e) => {
			const touch = e.touches[0]
			if (touch) applyTilt(touch.clientX, touch.clientY)
		},
		{ passive: true },
	)
	cardEl.addEventListener("touchend", resetTilt)
}

// Reset owns every result -> intro state mutation. Keeping this in one commit function prevents
// layout, scroll, share-cache and animation cleanup from drifting apart over time.
function commitIntroState() {
	const uploadedImage = document.getElementById("uploadedImage")
	const uploadContainer = document.getElementById("uploadedImageContainer")
	const introEl = document.getElementById("introSection")
	const resultsEl = document.getElementById("resultsContainer")

	resultsEl.style.display = "none"
	resultsEl.style.opacity = ""
	resultsEl.style.transform = ""
	document.body.classList.remove("result-mode")
	uploadedImage.src = "assets/imgs/placeholder.svg"
	uploadContainer.classList.remove("has-photo")
	document.getElementById("uploadImage").value = ""
	clearResults()
	introEl.style.display = ""
	uploadContainer.style.display = ""
	if (typeof gsap !== "undefined") gsap.set([introEl, uploadContainer, resultsEl], { clearProps: "opacity,transform" })
	window.scrollTo({ top: 0, left: 0, behavior: "auto" })
}

let resetTransitionPromise = null
function resetToIntro() {
	if (resetTransitionPromise) return resetTransitionPromise
	const introEl = document.getElementById("introSection")
	const resultsEl = document.getElementById("resultsContainer")
	const reducedMotion = prefersReducedMotion()

	// State commits immediately. Animation explains the new state but never gates navigation or layout.
	// This mirrors Motion's interruption-friendly model and avoids waiting on a long offscreen result tree.
	cancelShareArtifactPreparation()
	if (typeof gsap !== "undefined") gsap.killTweensOf([resultsEl, introEl, ".reading-item", ".radar-poly"])
	commitIntroState()

	if (reducedMotion || typeof gsap === "undefined") return Promise.resolve()
	resetTransitionPromise = new Promise((resolve) => {
		gsap.fromTo(introEl,
			{ opacity: 0, y: 8, scale: 0.995 },
			{
				opacity: 1,
				y: 0,
				scale: 1,
				duration: MOTION.resetEnter,
				ease: MOTION.easeOut,
				clearProps: "opacity,transform",
				onComplete: resolve,
			},
		)
	}).finally(() => {
		resetTransitionPromise = null
	})
	return resetTransitionPromise
}

document.getElementById("reset").addEventListener("click", () => {
	playClick()
	resetToIntro()
})

// 실제 분석이 이보다 빨리 끝나도(MediaPipe는 로컬에서 꽤 빠름) 최소 이만큼은 "안개" 상태를
// 유지한다. 그렇지 않으면 들어오는 애니메이션과 나가는 애니메이션이 서로 충돌해 뚝뚝 끊겨 보인다.
const MIN_LOADING_MS = 900
let loadingStartedAt = 0
let loadingRunId = 0
let loadingMessageTimer = null

const LOADING_MESSAGES = [
	"사진을 준비하는 중입니다...",
	"얼굴 랜드마크를 찾는 중입니다...",
	"6가지 얼굴 비율을 비교하는 중입니다...",
	"가장 가까운 매치를 정리하는 중입니다...",
]

function startLoadingMessages() {
	stopLoadingMessages()
	const el = document.getElementById("loadingStatus")
	if (!el) return
	let i = 0
	el.textContent = LOADING_MESSAGES[0]
	loadingMessageTimer = setInterval(() => {
		i = (i + 1) % LOADING_MESSAGES.length
		el.textContent = LOADING_MESSAGES[i]
	}, 650)
}

function stopLoadingMessages() {
	if (loadingMessageTimer) {
		clearInterval(loadingMessageTimer)
		loadingMessageTimer = null
	}
}

function showLoadingModal() {
	loadingRunId += 1
	const runId = loadingRunId
	loadingStartedAt = performance.now()
	const modal = document.getElementById("loadingModal")
	const content = modal.querySelector(".modal-content")
	const progress = document.getElementById("progressBarInner")
	const reducedMotion = prefersReducedMotion()

	document.documentElement.classList.add("analysis-active")
	document.body.classList.add("analysis-active")
	if (typeof gsap !== "undefined") gsap.killTweensOf([modal, content, "#portalFlash"])
	modal.style.display = "block"
	modal.style.pointerEvents = "auto"
	if (progress) {
		progress.style.animation = "none"
		void progress.offsetWidth
		progress.style.animation = ""
	}
	startLoadingMessages()

	if (reducedMotion || typeof gsap === "undefined") {
		modal.style.opacity = "1"
		content.style.opacity = "1"
		content.style.transform = "translate(-50%, -50%)"
		return runId
	}

	// The surface is immediate so feedback never disappears. The card itself settles with a short,
	// zero-bounce Motion-style transform while remaining visible throughout.
	modal.style.opacity = "1"
	content.style.opacity = "1"
	content.style.transform = "translate(-50%, -50%)"
	gsap.fromTo(content,
		{ opacity: 0.72, y: 6, scale: 0.99 },
		{ opacity: 1, y: 0, scale: 1, duration: MOTION.loaderContentEnter, ease: MOTION.easeOut, clearProps: "y,scale" },
	)
	gsap.fromTo("#portalFlash", { opacity: 0 }, { opacity: 0.12, duration: 0.10, yoyo: true, repeat: 1, ease: "sine.inOut" })
	return runId
}

async function hideLoadingModal(runId = loadingRunId) {
	const modal = document.getElementById("loadingModal")
	const content = modal.querySelector(".modal-content")
	const reducedMotion = prefersReducedMotion()
	const elapsed = performance.now() - loadingStartedAt
	if (elapsed < MIN_LOADING_MS) await new Promise((resolve) => setTimeout(resolve, MIN_LOADING_MS - elapsed))
	if (runId !== loadingRunId) return
	stopLoadingMessages()

	const finalize = () => {
		if (runId !== loadingRunId) return
		modal.style.display = "none"
		modal.style.opacity = ""
		modal.style.pointerEvents = ""
		content.style.opacity = ""
		content.style.transform = ""
		document.documentElement.classList.remove("analysis-active")
		document.body.classList.remove("analysis-active")
		if (typeof gsap !== "undefined") gsap.set([modal, content, "#portalFlash"], { clearProps: "opacity,transform" })
	}

	if (reducedMotion || typeof gsap === "undefined") {
		finalize()
		return
	}

	await new Promise((resolve) => {
		let finished = false
		let timeline = null
		const finish = () => {
			if (finished) return
			finished = true
			if (timeline) timeline.kill()
			finalize()
			resolve()
		}
		timeline = gsap.timeline({ onComplete: finish })
			.to(content, { opacity: 0, y: -4, scale: 0.995, duration: MOTION.loaderContentExit, ease: MOTION.easeIn }, 0)
			.to(modal, { opacity: 0, duration: MOTION.loaderSurfaceExit, ease: "power1.inOut" }, 0.04)
		setTimeout(finish, 380)
	})
}

function clearResults() {
	// 결과 리스트 및 평균 유사도 초기화
	cancelShareArtifactPreparation()
	shareResultGeneration += 1
	lastResultSummary = null
	shareCardReadyPromise = null
	invalidateShareArtifact()
	document.getElementById("averageResult").textContent = ""
	document.getElementById("aiInfoBadge").textContent = ""
}

/* share function */
const SHARE_FILE_NAME = "부자관상분석결과.png"
const SHARE_TITLE = "인공지능 부자 관상 테스트"
function downloadPreparedShareBlob(fallbackMessage = "") {
	if (!preparedShareBlob) return false
	const url = URL.createObjectURL(preparedShareBlob)
	const link = document.createElement("a")
	link.href = url
	link.download = SHARE_FILE_NAME
	link.click()
	setTimeout(() => URL.revokeObjectURL(url), 1500)
	if (fallbackMessage) showToast(fallbackMessage)
	return true
}
function ensurePreparedShareArtifact() {
	if (preparedShareBlob) return true
	prepareShareArtifact().catch((err) => {
		console.warn("공유 카드 준비 실패", err)
		showToast("공유 이미지를 준비하지 못했습니다. 잠시 후 다시 시도해주세요.")
	})
	showToast("공유 이미지를 준비하는 중입니다. 잠시 후 다시 눌러주세요.")
	return false
}
document.getElementById("saveImgBtn").addEventListener("click", function () {
	playClick()
	if (!ensurePreparedShareArtifact()) return
	trackEvent("save_image")
	downloadPreparedShareBlob()
})
function buildShareText() {
	if (!lastResultSummary) return "나의 부자 관상 분석 결과!"
	const { topMatchName, archetypeName, topSimilarity } = lastResultSummary
	if (topMatchName && archetypeName) return `나는 ${topMatchName}과 ${topSimilarity}% 닮은 '${archetypeName}' 관상?! 내 결과와 비교해봐.`
	if (archetypeName) return `나는 재벌 표본과 ${topSimilarity}% 닮은 '${archetypeName}' 관상?! 내 결과와 비교해봐.`
	return "나의 부자 관상 분석 결과!"
}

function buildChallengeUrl() {
	if (!lastResultSummary || !lastResultSummary.topMatchId) return document.querySelector('link[rel="canonical"]').href
	const canonical = new URL(document.querySelector('link[rel="canonical"]').href)
	canonical.searchParams.set("via", "share")
	canonical.searchParams.set("match", lastResultSummary.topMatchId)
	canonical.searchParams.set("score", lastResultSummary.topSimilarity)
	return canonical.toString()
}

function trackShareLinkCreated(method) {
	if (!lastResultSummary) return
	trackEvent("share_link_created", {
		method,
		match_id: lastResultSummary.topMatchId,
		score: lastResultSummary.topSimilarity,
	})
}

async function copyChallengeUrl(challengeUrl) {
	if (!navigator.clipboard || !navigator.clipboard.writeText) return false
	try {
		await navigator.clipboard.writeText(challengeUrl)
		return true
	} catch (err) {
		console.warn("도전 링크 복사 실패", err)
		return false
	}
}

function sharePreparedCard(fallbackMessage, method) {
	if (!ensurePreparedShareArtifact()) return
	const challengeUrl = buildChallengeUrl()
	const file = new File([preparedShareBlob], SHARE_FILE_NAME, { type: "image/png" })
	const payload = { files: [file], title: SHARE_TITLE, text: buildShareText(), url: challengeUrl }
	if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
		try {
			navigator.share(payload).then(() => trackShareLinkCreated(method)).catch((err) => {
				if (err.name === "AbortError") return
				console.warn("공유 실패", err)
				showToast("공유 시트를 열지 못했습니다. 저장 버튼으로 이미지를 저장해 공유해주세요.")
			})
			return
		} catch (err) { console.warn("공유 실패", err) }
	}
	if (navigator.share) {
		navigator.share({ title: SHARE_TITLE, text: buildShareText(), url: challengeUrl })
			.then(() => trackShareLinkCreated(method + "_link"))
			.catch((err) => { if (err.name !== "AbortError") console.warn("링크 공유 실패", err) })
		return
	}
	copyChallengeUrl(challengeUrl).then((copied) => {
		downloadPreparedShareBlob(copied ? `${fallbackMessage} 비교 링크도 클립보드에 복사했습니다.` : fallbackMessage)
		if (copied) trackShareLinkCreated(method + "_clipboard")
	})
}

document.getElementById("webShareBtn").addEventListener("click", function () {
	playClick()
	if (!preparedShareBlob) { ensurePreparedShareArtifact(); return }
	trackEvent("share_click", { method: "web_share" })
	sharePreparedCard("이 브라우저는 파일 공유 시트를 지원하지 않아 이미지를 저장했습니다.", "web_share")
})
document.getElementById("instagramShareBtn").addEventListener("click", function () {
	playClick()
	if (!preparedShareBlob) { ensurePreparedShareArtifact(); return }
	trackEvent("share_click", { method: "instagram" })
	sharePreparedCard("인스타그램은 웹에서 바로 업로드할 수 없어 이미지를 저장했습니다.", "instagram")
})
