// script.js가 실행되기 시작했다는 것 자체가 "이제부터 클릭이 실제로 동작한다"는 뜻이므로,
// 가장 먼저(다른 어떤 로직보다도 앞서) 부팅 오버레이부터 걷어낸다.
document.getElementById("bootOverlay")?.remove()

// 카카오 디벨로퍼스(developers.kakao.com)에서 발급받은 "JavaScript 키"를 여기에 붙여넣으세요.
// 이 키는 비밀값이 아니라 카카오 콘솔에서 도메인 화이트리스트로 보호되는 공개용 키입니다.
const KAKAO_JS_KEY = "b9b76fcef8436714dacc3c76d6843731"

// ===== 효과음 (Tone.js로 직접 합성 — 외부 음원 파일 없이 저작권 이슈 없이 재생) =====
let sfx = null
async function ensureSfx() {
	if (sfx) return sfx
	if (typeof Tone === "undefined") return null
	await Tone.start()
	sfx = {
		click: new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 2, volume: -18 }).toDestination(),
		whooshNoise: new Tone.Noise("white").start(),
		whooshFilter: new Tone.Filter({ frequency: 200, type: "bandpass", Q: 1.2 }).toDestination(),
		chime: new Tone.PolySynth(Tone.FMSynth, { volume: -10 }).toDestination(),
	}
	sfx.whooshNoise.connect(sfx.whooshFilter)
	sfx.whooshNoise.volume.value = -Infinity
	return sfx
}

function playClick() {
	if (!sfx) return
	sfx.click.triggerAttackRelease("C2", "32n")
}

function playWhoosh(direction) {
	if (!sfx) return
	const now = Tone.now()
	sfx.whooshNoise.volume.cancelScheduledValues(now)
	sfx.whooshNoise.volume.setValueAtTime(-Infinity, now)
	sfx.whooshNoise.volume.linearRampToValueAtTime(-14, now + 0.05)
	sfx.whooshNoise.volume.linearRampToValueAtTime(-Infinity, now + 0.4)
	sfx.whooshFilter.frequency.cancelScheduledValues(now)
	if (direction === "out") {
		sfx.whooshFilter.frequency.setValueAtTime(200, now)
		sfx.whooshFilter.frequency.exponentialRampToValueAtTime(4000, now + 0.4)
	} else {
		sfx.whooshFilter.frequency.setValueAtTime(4000, now)
		sfx.whooshFilter.frequency.exponentialRampToValueAtTime(200, now + 0.4)
	}
}

function playChime() {
	if (!sfx) return
	sfx.chime.triggerAttackRelease(["C5", "E5", "G5"], "8n")
}

// 나이 추정만 face-api.js를 계속 사용 (MediaPipe Tasks Vision에는 대응하는 로컬 나이 추정 모델이 없음)
async function loadAgeModel() {
	const MODEL_URL = "./models"
	await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL)
	await faceapi.nets.ageGenderNet.loadFromUri(MODEL_URL)
}

// MediaPipe FaceLandmarker + faceFeatures.js는 ESM이라 동적 import로 로드
let mediapipeModules = null
async function ensureMediapipeModules() {
	if (mediapipeModules) return mediapipeModules
	const [vision, features] = await Promise.all([import("./vendor/mediapipe/vision_bundle.mjs"), import("./faceFeatures.js")])
	mediapipeModules = { ...vision, ...features }
	return mediapipeModules
}

// 카카오톡/X 공유 문구를 "나의 부자 관상 분석 결과!" 같은 뻔한 고정 문구 대신 실제 결과로
// 채우기 위해 가장 최근 결과를 기억해둔다 — 개인화된 문구가 공유율이 훨씬 높다는 건
// 마케팅 콘텐츠의 기본 원리.
let lastResultSummary = null

// populateShareCard()가 진행 중인 마지막 Promise — captureShareCard()가 캡처 전에 기다린다
// (사진 비율 보정을 위한 캔버스 크롭이 비동기라 생긴 경쟁 상태를 막기 위함).
let shareCardReadyPromise = null

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
})

let faceLandmarkerInstance = null
async function ensureFaceLandmarker() {
	if (faceLandmarkerInstance) return faceLandmarkerInstance
	const { FaceLandmarker, FilesetResolver } = await ensureMediapipeModules()
	const fileset = await FilesetResolver.forVisionTasks("./js/vendor/mediapipe/wasm")
	faceLandmarkerInstance = await FaceLandmarker.createFromOptions(fileset, {
		baseOptions: { modelAssetPath: "./models/mediapipe/face_landmarker.task", delegate: "CPU" },
		outputFaceBlendshapes: true,
		runningMode: "IMAGE",
		numFaces: 1,
	})
	return faceLandmarkerInstance
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

// 페이지 로드 시 기본 이미지 설정
window.onload = function () {
	const uploadedImage = document.getElementById("uploadedImage")
	uploadedImage.src = "assets/imgs/placeholder.svg"
	uploadedImage.style.display = "block"
}

// 이미지 클릭 시 파일 업로드 트리거 (오디오 컨텍스트는 반드시 사용자 제스처 안에서 시작해야 함)
document.getElementById("uploadedImage").addEventListener("click", function () {
	ensureSfx().then(playClick)
	document.getElementById("uploadImage").click()
})

// 위 리스너를 붙이는 줄이 실행됐다는 건 이 시점부터 클릭이 실제로 동작한다는 뜻이므로,
// 그제서야 "초기화 중" 표시를 걷어낸다. index.html에서 모든 외부 스크립트를 defer로 바꾸고
// script.js를 맨 마지막에 두었기 때문에, 이 줄이 실행되는 시점엔 GSAP/Tone/face-api 등
// 의존 라이브러리도 이미 전부 로드가 끝나 있다.
document.getElementById("uploadedImageContainer").classList.remove("is-initializing")

// 메인 카드가 공중에 살짝 떠 있는 듯한 아이들 애니메이션.
// 처음엔 y/회전을 크게 줬더니 버튼을 누르려 할 때 타겟이 계속 움직여서 불편하다는 피드백을
// 받고, 회전은 아예 빼고 y 이동폭도 크게 줄였다 — 시선 끝에서 아주 은은하게만 느껴지는 정도.
// script.js를 라이브러리들보다 먼저 실행하도록 순서를 바꿨기 때문에, 이 시점엔 아직 gsap이
// 로드되지 않았을 수 있다 — window의 load 이벤트(모든 defer 스크립트 실행이 끝난 뒤 발생)까지
// 기다렸다가 시작한다.
window.addEventListener("load", function () {
	if (typeof gsap === "undefined") return
	gsap.to(".container", {
		y: -3,
		duration: 3.4,
		repeat: -1,
		yoyo: true,
		ease: "sine.inOut",
	})
})

// 이미지 업로드 시 처리
document.getElementById("uploadImage").addEventListener("change", function () {
	const file = this.files[0]
	if (file) {
		const reader = new FileReader()
		reader.onload = async function (e) {
			const uploadedImage = document.getElementById("uploadedImage")
			uploadedImage.src = e.target.result
			uploadedImage.style.display = "block"
			clearResults() // 이미지가 업로드될 때마다 결과 초기화
			await processImage(uploadedImage.src)
		}
		reader.readAsDataURL(file)
	}
})

// data/embeddings.json: tools/precompute.html(MediaPipe 기반)로 미리 계산해둔
// { featureKeys, stats: {mean, std}, people: [{..., features}] } 구조.
// 성별 구분 없이 전체 인물 표본 하나로 통합 (여성 표본이 너무 적어 따로 나누는 의미가 없음).
async function loadEmbeddings() {
	const res = await fetch(`data/embeddings.json`)
	if (!res.ok) throw new Error("비교 데이터를 불러오지 못했습니다.")
	const data = await res.json()
	if (!data || !Array.isArray(data.people) || data.people.length === 0) {
		throw new Error("비교 데이터가 비어 있습니다.")
	}
	return data
}

function toMatch(person, similarity) {
	return {
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
	}
}

// z-score 거리를 0~100 유사도로 변환. SIMILARITY_SCALE은 실측 분포로 보정된 값.
const SIMILARITY_SCALE = 14

// zscoreDistance는 항목별 z-score를 ±2로 묶어도, 매칭된 사람이 여러 항목에서 동시에
// 극단값(±2)인 데다 업로드한 얼굴이 반대쪽 극단이면 이론상 거리가 최대치(6항목 모두 4씩
// 벌어짐, sqrt(6*4^2)≈9.8)까지 나올 수 있어 0%가 완전히 불가능하진 않다. "일치율 0.0%인데
// 이 사람이 매칭됐다"는 문구 자체가 모순으로 읽히므로, 이름이 있는 매칭에는 항상 0보다
// 뚜렷하게 큰 최소값을 보장한다(등급표의 최하단 "완전히 반대" 구간 안에 자연스럽게 들어감).
const MIN_SIMILARITY = 3

function similarityFromDistance(distance) {
	return Math.max(MIN_SIMILARITY, 100 - distance * SIMILARITY_SCALE)
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

async function processImage(imageSrc) {
	showLoadingModal()

	try {
		// "사람 얼굴을 포함한 이미지를 선택해주세요"라는 문구 하나로 모든 실패를 뭉뚱그리면,
		// 실제로 얼굴 사진을 올렸는데 모델 로딩이 실패했거나 인식만 애매했던 경우에도 "얼굴을
		// 안 넣었다"는 식으로 읽혀서 사용자를 오해하게 만든다는 피드백 — 실패 지점별로 원인이
		// 구분되는 메시지를 따로 준다.
		let modules
		try {
			modules = await ensureMediapipeModules()
		} catch (err) {
			console.error(err)
			showToast("얼굴 인식 모듈을 불러오지 못했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.")
			return
		}
		const { computeFeatures, FEATURE_KEYS, FEATURE_LABELS, zscoreDistance, zscoreToPercentile } = modules

		let landmarker
		try {
			;[landmarker] = await Promise.all([ensureFaceLandmarker(), loadAgeModel()])
		} catch (err) {
			console.error(err)
			showToast("얼굴 인식 모델을 불러오지 못했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.")
			return
		}

		const uploadedImage = document.getElementById("uploadedImage")
		const detectionCanvas = toDetectionCanvas(uploadedImage)
		const detection = landmarker.detect(detectionCanvas)
		const landmarks = detection.faceLandmarks && detection.faceLandmarks[0]

		if (!landmarks) {
			// 실제로는 얼굴이 있어도 각도/조명/거리 때문에 인식만 실패하는 경우가 흔하다.
			// "얼굴을 포함한 사진을 골라라"는 마치 사용자가 얼굴 없는 사진을 낸 것처럼 들려서
			// 진짜 얼굴 사진을 냈는데도 이 메시지를 보면 오해한다 — "인식하지 못했다"로 바꾸고
			// 실제로 도움이 되는 팁(정면/밝기)을 함께 준다.
			showToast("얼굴을 정확히 인식하지 못했습니다. 정면을 향한 밝은 사진으로 다시 시도해주세요.")
			return
		}

		const featureObj = computeFeatures(landmarks, detectionCanvas.width, detectionCanvas.height)
		const uploadedFeatures = FEATURE_KEYS.map((k) => featureObj[k])

		let embeddingsData
		try {
			embeddingsData = await loadEmbeddings()
		} catch (err) {
			console.error(err)
			showToast("표본 데이터를 불러오지 못했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.")
			return
		}
		const blendshapeCategories = detection.faceBlendshapes && detection.faceBlendshapes[0] && detection.faceBlendshapes[0].categories
		const expression = blendshapeCategories ? topExpressionFromBlendshapes(blendshapeCategories) : null

		let age = null
		try {
			const ageDetection = await faceapi.detectSingleFace(detectionCanvas, new faceapi.TinyFaceDetectorOptions()).withAgeAndGender()
			if (ageDetection) age = Math.round(ageDetection.age)
		} catch (err) {
			console.warn("나이 추정 실패", err)
		}

		const percentiles = (features) => FEATURE_KEYS.map((k, i) => zscoreToPercentile(features[i], embeddingsData.stats.mean[i], embeddingsData.stats.std[i]))
		const userPercentiles = percentiles(uploadedFeatures)

		// 각 특징(이마/눈/코/입/턱/얼굴형)별로, 실명이 있는 인물 중 그 항목이 나와 가장 비슷한 사람을 찾는다.
		// "재벌 평균과 비교하면"보다 "이 부위는 OOO 회장과 닮았다"는 게 훨씬 흥미롭다는 피드백 반영.
		const namedPeople = embeddingsData.people.filter((p) => p.name)
		const nearestByFeature = FEATURE_KEYS.map((_, i) => {
			if (namedPeople.length === 0) return null
			const userZ = (uploadedFeatures[i] - embeddingsData.stats.mean[i]) / embeddingsData.stats.std[i]
			let best = null
			let bestDist = Infinity
			for (const person of namedPeople) {
				const personZ = (person.features[i] - embeddingsData.stats.mean[i]) / embeddingsData.stats.std[i]
				const dist = Math.abs(userZ - personZ)
				if (dist < bestDist) {
					bestDist = dist
					best = person
				}
			}
			return best
		})

		// "누굴 올려도 이재용/정몽준 몇 명으로만 귀결된다"는 신고 — 실측해보니 실제 버그가
		// 아니라 통계적 현상이었다. 후보가 14명뿐인 좁은 풀에서 "전체 6개 항목을 합친 거리가
		// 가장 가까운 한 명"을 고르면, 재벌 표본 평균에 가까운("제일 평범한") 한두 명이 어떤
		// 입력에도 수학적으로 거의 항상 이겨버린다(nearest-neighbor의 "허브" 문제 — 50명의
		// 검증용 얼굴로 시뮬레이션한 결과 상위 1명이 32%, 상위 2명이 54%를 독식했다).
		//
		// "닮음"의 정의 자체를 바꿔서 이 문제를 근본적으로 없앤다: 전체 얼굴을 뭉뚱그려
		// 비교하는 대신, "이 사람에게서 가장 두드러지는 특징(=재벌 유형을 정하는 것과 같은
		// 축)이 재벌 14명 중 누구와 제일 가깝나"로 고른다. 항상 평균적인 사람은 어느 축으로
		// 봐도 "가장 극단적인 사람"이 될 수 없으므로, 이 방식은 허브 문제가 구조적으로
		// 생기지 않는다(같은 시뮬레이션에서 1명 최대 14%, 12/14명이 최소 한 번은 뽑힘).
		// 부수 효과로 "재벌 유형" 배지와 "가장 닮은 재벌"이 이제 같은 특징에서 나온 하나의
		// 이야기가 된다: "당신은 이마가 재벌 표본 평균보다 넓은 전략가형이고, 그 이마가
		// 이재용과 가장 닮았다" — 예전엔 이 둘이 서로 다른 계산이라 우연히 다른 사람을
		// 가리킬 수 있었다.
		const radarForArchetype = { keys: FEATURE_KEYS, labels: FEATURE_KEYS.map((k) => FEATURE_LABELS[k]), user: userPercentiles }
		const archetype = computeArchetype(radarForArchetype)
		const dominantIdx = FEATURE_KEYS.indexOf(archetype.featureKey)
		const matchedPerson = nearestByFeature[dominantIdx]

		// 헤드라인 %는 그대로 "전체 6개 항목 기준 종합 유사도"를 쓴다 — 이미 튜닝된
		// SIMILARITY_SCALE/등급 체계를 그대로 재사용할 수 있고, "특정 부위는 많이 닮았지만
		// 전체적으로는 어느 정도"라는 게 오히려 더 정직하고 납득되는 서사가 된다.
		const topMatchDistance = zscoreDistance(uploadedFeatures, matchedPerson.features, embeddingsData.stats)
		const topMatch = toMatch(matchedPerson, similarityFromDistance(topMatchDistance))

		const radar = {
			keys: FEATURE_KEYS,
			labels: FEATURE_KEYS.map((k) => FEATURE_LABELS[k]),
			user: userPercentiles,
			match: percentiles(topMatch.features),
			matchLabel: topMatch.name,
			nearestByFeature,
		}

		renderResults({ age, expression }, radar, archetype, topMatch)
	} catch (err) {
		console.error(err)
		showToast("분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.")
	} finally {
		await hideLoadingModal()
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
		high: { name: "전략가형", desc: "판단이 빠르고 윗사람의 발탁운이 따르는 타입" },
		low: { name: "대기만성형", desc: "신중하게 내실을 다지다 늦게 크게 트이는 타입" },
	},
	eyeSpacingRatio: {
		high: { name: "리더형", desc: "마음이 트여있고 인맥이 넓은 타입" },
		low: { name: "승부사형", desc: "한 우물을 깊게 파는 창업가 타입" },
	},
	noseLengthRatio: {
		high: { name: "재물 축적형", desc: "재물을 차곡차곡 쌓는 타입" },
		low: { name: "실속형", desc: "규모보다 실속을 먼저 챙기는 타입" },
	},
	mouthWidthRatio: {
		high: { name: "승부사형", desc: "말 한마디로 조직을 움직이는 타입" },
		low: { name: "신뢰형", desc: "말수는 적지만 한마디에 무게가 실리는 타입" },
	},
	jawRatio: {
		high: { name: "승계자형", desc: "뚝심과 추진력이 강하고 말년의 복이 두터운 타입" },
		low: { name: "임기응변형", desc: "유연하고 임기응변에 강한 타입" },
	},
	faceAspectRatio: {
		high: { name: "참모·기획형", desc: "섬세하고 전략적으로 움직이는 타입" },
		low: { name: "오너형", desc: "원만하고 복이 들어오는 인상의 타입" },
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
	const rankText = percentile >= 50 ? `상위 ${Math.max(1, 100 - percentile)}%` : `하위 ${Math.max(1, percentile)}%`
	return { name: archetype.name, desc: archetype.desc, featureKey: key, featureLabel: radar.labels[bestIdx], rankText }
}

// 전통 관상학의 오악/궁(宮) 개념을 빌려온 해석 문구.
// high/mid/low는 재벌 표본 집단 대비 백분위(percentile) 기준.
const FEATURE_READINGS = {
	foreheadRatio: {
		icon: "brain",
		label: "이마 · 초년운",
		tooltip: "헤어라인부터 눈썹까지의 높이를 얼굴 전체 높이와 비교한 비율입니다. 관상학에서는 이 부위를 어린 시절부터 청년기까지의 운, '초년운'으로 봅니다.",
		high: "재벌 표본 평균보다 이마가 훤칠하게 넓은 편입니다. 어릴 때부터 총명하고 판단이 빠르며, 윗사람의 발탁운이 따르는 재벌상의 이마 비율에 가깝습니다.",
		mid: "재벌 표본과 비슷한 이마 비율입니다. 무난하고 안정적인 초년운을 타고난 재벌형 이마에 가깝습니다.",
		low: "재벌 표본 평균보다 이마가 아담한 편입니다. 신중하게 내실을 다지는 상으로, 재벌들 사이에서도 늦게 크게 트이는 대기만성형에 속합니다.",
	},
	eyeSpacingRatio: {
		icon: "eye",
		label: "눈매 간격 · 대인궁",
		tooltip: "두 눈 사이의 간격을 얼굴 너비와 비교한 비율입니다. 관상학에서 눈가는 사람과의 관계·처세를 보는 '대인궁'에 해당합니다.",
		high: "재벌 표본 평균보다 눈 사이가 넓은 편입니다. 마음이 트여있고 포용력이 커, 재벌들 특유의 폭넓은 인맥형 눈매에 가깝습니다.",
		mid: "재벌 표본과 비슷한 눈매 간격입니다. 대인관계에서 균형 잡힌 처세를 보이는 재벌형에 가깝습니다.",
		low: "재벌 표본 평균보다 눈 사이가 좁은 편입니다. 집중력이 뛰어나 한 우물을 깊게 파는 상으로, 창업형 재벌들에게서 종종 보이는 눈매입니다.",
	},
	noseLengthRatio: {
		icon: "gem",
		label: "코 길이 · 재백궁(재물운)",
		tooltip: "콧대 길이를 얼굴 전체 높이와 비교한 비율입니다. 관상학에서 코는 재물을 담는 그릇, '재백궁'으로 재물운을 상징합니다.",
		high: "관상학에서 코는 재물을 담는 그릇, '재백궁'이라 했습니다. 재벌 표본 평균보다 콧대가 길게 뻗어 있어 재물을 차곡차곡 쌓는 전형적인 재벌 코에 가깝습니다.",
		mid: "재벌 표본과 비슷한 코 길이입니다. 크게 넘치지도 모자라지도 않게 재물을 관리하는 재벌형 재물운입니다.",
		low: "재벌 표본 평균보다 코가 아담한 편입니다. 씀씀이가 시원시원하고 규모보다 실속을 먼저 챙기는 재물운입니다.",
	},
	mouthWidthRatio: {
		icon: "smile",
		label: "입 너비 · 언변궁",
		tooltip: "입 너비를 얼굴 전체 너비와 비교한 비율입니다. 관상학에서 입은 말과 화술, 즉 '언변궁'을 나타내는 부위입니다.",
		high: "재벌 표본 평균보다 입이 큼직한 편입니다. 언변이 좋고 배포가 커, 말 한마디로 조직을 움직이는 재벌 특유의 입매에 가깝습니다.",
		mid: "재벌 표본과 비슷한 입 크기입니다. 신뢰감 있는 화법을 구사하는 재벌형 언변궁입니다.",
		low: "재벌 표본 평균보다 입이 아담한 편입니다. 말수는 적지만 한마디 한마디에 무게가 실리는 상입니다.",
	},
	jawRatio: {
		icon: "shieldCheck",
		label: "턱선 · 말년운",
		tooltip: "턱선의 뚜렷한 정도(폭·각짐)를 나타내는 비율입니다. 관상학에서 턱은 노년기의 안정과 결실, '말년운'을 보는 부위입니다.",
		high: "재벌 표본 평균보다 턱선이 두드러진 편입니다. 뚝심과 추진력이 강해, 관상학에서 말년의 복이 두텁다고 보는 재벌형 턱에 가깝습니다.",
		mid: "재벌 표본과 비슷한 턱선입니다. 안정적으로 목표를 이뤄가는 재벌형 말년운입니다.",
		low: "재벌 표본 평균보다 턱선이 갸름한 편입니다. 유연하고 임기응변에 강한 상입니다.",
	},
	faceAspectRatio: {
		icon: "squareUser",
		label: "얼굴형 · 전체 기질",
		tooltip: "얼굴 세로 길이를 가로 너비와 비교한 비율입니다. 값이 클수록 갸름한 얼굴형, 작을수록 둥근 얼굴형에 가까우며 전체적인 인상·기질을 나타냅니다.",
		high: "재벌 표본 평균보다 얼굴이 갸름한 편입니다. 섬세하고 전략적으로 움직이는 참모·기획형 재벌 기질에 가깝습니다.",
		mid: "재벌 표본과 비슷한 얼굴 비율입니다. 균형 잡힌 기질의 재벌형 얼굴형입니다.",
		low: "재벌 표본 평균보다 얼굴이 둥근 편입니다. 예로부터 원만하고 복이 들어오는 인상이라 전해지는, 오너형 재벌에게서 흔히 보이는 얼굴형입니다.",
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
			// 막대(표본 대비 백분위)와 "OOO과 N% 일치" 배지는 서로 다른 계산(전자는 47명 분포
			// 내 위치, 후자는 가장 가까운 한 명과의 근접도)인데 둘 다 숫자%라 나란히 붙어있으면
			// 막대는 62% 찼는데 옆 글자는 91%라고 해서 "둘이 왜 다르냐"는 혼란을 줬다 — 각자
			// 무엇을 재는 숫자인지 눈에 보이는 캡션을 따로 붙이고, 줄도 분리한다.
			const percentileCaption = percentile >= 50 ? `재벌 표본 대비 상위 ${Math.max(1, 100 - percentile)}%` : `재벌 표본 대비 하위 ${Math.max(1, percentile)}%`
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
			// 모든 항목에서 100%가 나온다), 바로 위 백분위 막대와 다른 계산이라 숫자가 서로
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
			return `<text x="${lx}" y="${ly}" font-size="10" fill="#e8d9a0" text-anchor="middle" dominant-baseline="middle">${label}</text>`
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
				<div class="topMatch-percent" id="topMatchPercent">0.0%</div>
				<div class="topMatch-photo-box"><img src="${match.image}" alt="${match.name}"><span>${match.name}</span></div>
			</div>
		`
		: ""

	return `
		<div id="topMatch">
			<div id="topMatchShine"></div>
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

function renderResults(aiInfo, radar, archetype, topMatch) {
	// 메인 지표는 "가장 닮은 인물과의 일치율" 하나로 통일한다. topMatch는 processImage에서
	// 이미 "가장 두드러지는 특징이 누구와 가장 가까운지"로 정해서 넘겨준다 — 여기서 다시
	// 고르지 않는다(레이더 차트가 비교하는 사람과 헤드라인/카드에 나오는 사람이 어긋나지
	// 않도록 항상 같은 곳에서 한 번만 결정한다).
	const topSimilarity = topMatch.similarity.toFixed(1)

	const readingHtml = renderFeatureReadings(radar)

	// AI 추정 나이/표정은 "이 매칭 결과"가 아니라 "업로드한 사진 자체"에 대한 정보라,
	// 결과 카드 쪽 템플릿이 아니라 사진 위 뱃지에 직접 채운다. 나이/표정 둘 다 실패할 수
	// 있어 있는 것만 넣고, 하나도 없으면 빈 채로 둔다(CSS :empty로 뱃지 자체를 숨김).
	const aiBadgeLines = []
	if (aiInfo && aiInfo.age) aiBadgeLines.push(`<span class="ai-badge-line">${aiInfo.age}세</span>`)
	if (aiInfo && aiInfo.expression) aiBadgeLines.push(`<span class="ai-badge-line ai-badge-sub">${aiInfo.expression.label} ${(aiInfo.expression.score * 100).toFixed(0)}%</span>`)
	document.getElementById("aiInfoBadge").innerHTML = aiBadgeLines.join("")

	// 조건에 따른 등급 설정 (topSimilarity 기준: 100%에 가까울수록 "재벌상"이라는
	// 일반적인 직관에 맞춘 등급). 라벨을 따로 빼두는 건 공유 카드에서도 그대로 재사용하기 위함.
	let tierLabel = ""
	let tierDesc = ""
	if (topSimilarity >= 90) {
		tierLabel = "완벽한 재벌관상"
		tierDesc = "타고난 카리스마와 권력의 상징. 재벌 이미지를 그대로 품은 외모."
	} else if (topSimilarity >= 80) {
		tierLabel = "거의 재벌관상"
		tierDesc = "힘과 부를 상징하는 외모, 성공한 사람의 분위기."
	} else if (topSimilarity >= 70) {
		tierLabel = "확실한 재벌 느낌"
		tierDesc = "권위와 부유함이 강하게 나타남."
	} else if (topSimilarity >= 60) {
		tierLabel = "눈에 띄는 특징"
		tierDesc = "리더십과 자신감이 표출되기 시작."
	} else if (topSimilarity >= 50) {
		tierLabel = "잠재력 있음"
		tierDesc = "카리스마나 부유함의 기운이 약간 느껴짐."
	} else if (topSimilarity >= 40) {
		tierLabel = "중간 단계"
		tierDesc = "재벌관상과는 약간의 유사성, 하지만 확실하지 않음."
	} else if (topSimilarity >= 30) {
		tierLabel = "평범함"
		tierDesc = "특별히 눈에 띄지 않는 인상."
	} else if (topSimilarity >= 20) {
		tierLabel = "부족한 요소"
		tierDesc = "자신감이나 권위가 부족한 인상."
	} else if (topSimilarity >= 10) {
		tierLabel = "근본적인 차이"
		tierDesc = "재벌 느낌과는 전혀 어울리지 않음."
	} else {
		tierLabel = "완전히 반대"
		tierDesc = "재벌과는 거리가 먼 평범한 외모."
	}
	// 등급 문구("눈에 띄는 특징" 등)는 매칭 카드(사진·레이더 차트) 맨 위로 합쳐서 넣는다 —
	// 예전엔 이 문구가 "OOO과 가장 닮았어요"까지 따로 말하고, 바로 아래 카드에 또 같은
	// 이름이 나와서 중복이었다는 피드백 반영. topMatch는 항상 실명 있는 인물이다(namedPeople이
	// 비어 있으면 processImage의 matchedPerson.name 참조에서 이미 예외로 걸러진다).
	const topMatchHtml = `<div id="topMatchReveal" class="pending-reveal">${renderTopMatch(topMatch, radar, tierLabel, tierDesc)}</div>`

	// 마케팅 관점: %는 잊어도 "나는 OO형"이라는 정체성 라벨은 기억하고 공유한다(MBTI류
	// 성향테스트가 검증한 패턴). 6개 항목 중 재벌 표본 평균에서 가장 크게 벗어난 항목 하나를
	// "당신을 가장 잘 설명하는 특징"으로 뽑아 유형 배지로 승격한다.
	const archetypeHtml = archetype
		? `
			<div id="archetypeBadge">
				<span id="archetypeEyebrow">당신의 재벌 유형</span>
				<span id="archetypeName">${icon(FEATURE_READINGS[archetype.featureKey].icon, "archetype-icon")}${archetype.name}</span>
				<p id="archetypeDesc">${archetype.featureLabel} 재벌 표본 ${archetype.rankText} — ${archetype.desc}</p>
			</div>
		`
		: ""

	const divider = `<div class="section-divider"><span></span>✦<span></span></div>`

	// 결과 출력. 헤드라인 %는 예전엔 "나의 관상 분석 결과" 제목 아래 큰 텍스트 블록으로 따로
	// 떠 있었는데, 숫자가 정작 "무엇에 대한 숫자인지"(업로드한 내 사진)와 시각적으로 떨어져
	// 있어 어색하다는 피드백 — 텍스트 블록을 걷어내고 업로드된 내 사진 위에 뱃지로 박아서
	// 사진과 숫자가 한 덩어리로 보이게 한다.
	document.getElementById("averageResult").innerHTML = `
		<div id="resultRate">
			${archetypeHtml}
			${divider}${topMatchHtml}
			${readingHtml ? divider + readingHtml : ""}
		</div>
	`

	document.getElementById("resultsContainer").style.display = "block"

	// 소개 블록(태그라인/이용흐름/가치제안)과 업로드 사진 미리보기는 이미 결과를 받은
	// 사용자에겐 불필요한 반복이라는 피드백 — 결과가 나오면 통째로 숨긴다. 업로드 사진은
	// 아래 매칭 카드의 "나" 사진으로 대체되므로 정보 손실이 없다. (showLoadingModal에서 이미
	// 화면 전환용 퇴장 애니메이션을 재생했으므로, 여기선 완전히 레이아웃에서 빼기만 한다.)
	document.getElementById("introSection").style.display = "none"
	document.getElementById("uploadedImageContainer").style.display = "none"

	// 일치율 %는 이제 매칭 카드 안 "나 ≈ 매칭인물" 사이(#topMatchPercent)에 있다 — 카드 자체가
	// 500ms 뒤에야 리빌되므로, 카운트업도 그 타이밍(delay 0.6)에 맞춰야 숨겨진 채로 세는
	// 어색함이 없다.
	const topMatchPercentEl = document.getElementById("topMatchPercent")
	if (typeof gsap !== "undefined") {
		gsap.to(
			{ v: 0 },
			{
				v: parseFloat(topSimilarity),
				duration: 0.9,
				ease: "power2.out",
				delay: 0.6,
				onUpdate: function () {
					if (topMatchPercentEl) topMatchPercentEl.textContent = this.targets()[0].v.toFixed(1) + "%"
				},
			},
		)
		gsap.from(".reading-item", { opacity: 0, y: 10, duration: 0.4, stagger: 0.07, ease: "power2.out", delay: 0.9 })
		gsap.fromTo(".radar-poly", { scale: 0 }, { scale: 1, duration: 0.7, ease: "elastic.out(1, 0.65)", stagger: 0.12, delay: 0.55 })
	} else if (topMatchPercentEl) {
		topMatchPercentEl.textContent = topSimilarity + "%"
	}

	const revealEl = document.getElementById("topMatchReveal")
	if (revealEl) {
		// 짧은 대기 후 카드가 팝업되는 연출 (두구두구 효과) + 차임 효과음
		requestAnimationFrame(() => {
			setTimeout(() => {
				revealEl.classList.add("revealed")
				playChime()
			}, 500)
		})
	}

	const cardEl = document.getElementById("topMatch")
	if (cardEl) initHoloEffect(cardEl)

	lastResultSummary = { topMatchName: topMatch.name, archetypeName: archetype && archetype.name, topSimilarity }
	// populateShareCard가 async(사진 비율 보정을 위한 캔버스 크롭 포함)라, 저장/공유 버튼을
	// 결과가 뜨자마자 바로 눌러도 안전하도록 그 Promise를 기억해뒀다가 captureShareCard에서
	// 반드시 기다리게 한다.
	shareCardReadyPromise = populateShareCard(topMatch, topSimilarity, tierLabel, archetype, radar)
	applyFaceHiddenState()
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
async function populateShareCard(topMatch, topSimilarity, tierLabel, archetype, radar) {
	const userPhotoSrc = document.getElementById("uploadedImage").src
	// 사진 박스 CSS 비율(128:160)에 맞춰 미리 크롭 — 위 cropImageToRatio 주석 참고.
	const PHOTO_RATIO = 128 / 160
	const [userCropped, matchCropped] = await Promise.all([cropImageToRatio(userPhotoSrc, PHOTO_RATIO), cropImageToRatio(topMatch.image, PHOTO_RATIO)])

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
}

// 저장/공유 버튼이 공용으로 사용할 카드 캡처. 폭은 360px로 고정하지만 높이는 레이더 차트
// 포함 여부에 따라 내용물 기준으로 자연스럽게 늘어난다(el.offsetHeight로 실측) —
// scale:3으로 캡처하면 실제 폭은 1080px, 세로는 그만큼 비례해서 커진다.
async function captureShareCard() {
	// populateShareCard의 사진 크롭(비동기)이 아직 끝나기 전에 캡처가 먼저 실행되면 옛
	// 사진이나 빈 이미지가 찍힐 수 있다 — 항상 마지막 population이 끝난 뒤에 캡처한다.
	if (shareCardReadyPromise) await shareCardReadyPromise
	const el = document.getElementById("shareCard")
	return html2canvas(el, {
		width: el.offsetWidth,
		height: el.offsetHeight,
		scale: 3,
		useCORS: true,
		backgroundColor: null,
	})
}

// 마우스/터치 위치에 따라 카드가 기울어지고 무지개 시광이 움직이는 홀로그래픽 효과
function initHoloEffect(cardEl) {
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

// 새로고침 없이 업로드 전 상태로 되돌린다 — 전체 리로드는 이미 로드된 라이브러리/모델을
// 버리고 초기화 시퀀스를 처음부터 다시 타게 만들어서 굳이 느려질 이유가 없다.
document.getElementById("reset").addEventListener("click", function () {
	playClick()
	const uploadedImage = document.getElementById("uploadedImage")
	uploadedImage.src = "assets/imgs/placeholder.svg"
	document.getElementById("uploadImage").value = "" // 같은 파일을 다시 선택해도 change가 발생하도록
	clearResults()
	document.getElementById("resultsContainer").style.display = "none"

	// 결과 화면 진입 시 숨겼던 소개 블록/업로드 미리보기를 되돌린다. showLoadingModal에서 건
	// z/opacity가 인라인 스타일로 남아있을 수 있어 clearProps로 완전히 지운 뒤 다시 보인다.
	const introEl = document.getElementById("introSection")
	const uploadEl = document.getElementById("uploadedImageContainer")
	if (typeof gsap !== "undefined") gsap.set([introEl, uploadEl], { clearProps: "all" })
	introEl.style.display = ""
	uploadEl.style.display = ""
})

// 실제 분석이 이보다 빨리 끝나도(MediaPipe는 로컬에서 꽤 빠름) 최소 이만큼은 "안개" 상태를
// 유지한다. 그렇지 않으면 들어오는 애니메이션과 나가는 애니메이션이 서로 충돌해 뚝뚝 끊겨 보인다.
const MIN_LOADING_MS = 900
let loadingStartedAt = 0

// 화면이 균일하게 페이드아웃되며 덮이는 "순간이동 출발" 연출 + 휘익 효과음 + 안쪽 골드
// 빛(#portalFlash)의 짧은 번쩍임. (예전엔 clip-path로 원을 키워서 덮었는데, 원이 다 자라기
// 전까지 화면 귀퉁이에 배경 물결무늬가 계속 비쳐서 "깜빡인다"는 신고를 반복해서 받았다 —
// opacity 페이드는 화면 전체가 한 번에 균일하게 바뀌어 그 문제가 구조적으로 없다.)
// GSAP/Tone이 아직 로드되기 전이거나 로드 실패한 극단적인 경우에도 분석 자체는 막히지 않도록
// 항상 modal을 보이게 만드는 폴백을 먼저 깔아둔다.
function showLoadingModal() {
	loadingStartedAt = Date.now()
	const modal = document.getElementById("loadingModal")
	modal.style.display = "block"
	startLoadingMessages()

	if (typeof gsap === "undefined") return
	playWhoosh("out")
	// 소개 블록+업로드 사진이 결과 화면에서는 통째로 숨겨지므로(renderResults에서 display:none),
	// 그 퇴장을 화면 전체 전환과는 별개로 "이 컴포넌트가 시청자 쪽으로 빠르게 다가오며 사라지는"
	// 느낌으로 연출한다 — animista의 slide-out-fwd-center를 GSAP z(=translateZ)로 재현
	// (body에 이미 걸려있는 perspective 덕에 z 이동이 확대되어 보인다).
	gsap
		.timeline()
		.to(["#introSection", "#uploadedImageContainer"], { z: 500, opacity: 0, duration: 0.4, ease: "power2.in" }, 0)
		.fromTo(modal, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, 0.05)
		.fromTo("#portalFlash", { opacity: 0 }, { opacity: 0.55, duration: 0.12, ease: "power1.out" }, 0.05)
		.to("#portalFlash", { opacity: 0, duration: 0.35, ease: "power2.out" }, 0.17)
		.to(".modal-content", { opacity: 1, duration: 0.2 }, 0.3)
}

// 화면이 다시 균일하게 걷히며 "먼 곳으로 순간이동해서 도착한" 듯 결과를 드러내는 연출 + 효과음.
// 최소 노출 시간을 채울 때까지 기다린 뒤, 나가는 애니메이션이 끝날 때까지 대기한다.
async function hideLoadingModal() {
	const modal = document.getElementById("loadingModal")

	const elapsed = Date.now() - loadingStartedAt
	if (elapsed < MIN_LOADING_MS) {
		await new Promise((resolve) => setTimeout(resolve, MIN_LOADING_MS - elapsed))
	}
	stopLoadingMessages()

	if (typeof gsap === "undefined") {
		modal.style.display = "none"
		return
	}

	playWhoosh("in")
	// #uploadedImageContainer/#introSection를 다시 드러내는 애니메이션은 없앴다 — renderResults가
	// 이 시점 이전에 이미 그 둘을 display:none으로 완전히 숨겼으므로(결과 화면에서는 계속
	// 숨김 상태 유지), 여기서 다시 보이게 하면 방금 숨긴 걸 되살리는 꼴이 된다. 다시 보이는
	// 시점은 "다른 사진으로 다시 하기" 클릭(초기화 핸들러)뿐이다.
	await new Promise((resolve) => {
		gsap
			.timeline({
				onComplete: () => {
					modal.style.display = "none"
					gsap.set([modal, "#portalFlash", ".modal-content"], { clearProps: "all" })
					resolve()
				},
			})
			.to(".modal-content", { opacity: 0, duration: 0.12 }, 0)
			.fromTo("#portalFlash", { opacity: 0 }, { opacity: 0.55, duration: 0.1 }, 0.12)
			.to("#portalFlash", { opacity: 0, duration: 0.3 }, 0.22)
			.to(modal, { opacity: 0, duration: 0.3, ease: "power2.in" }, 0.15)
	})
}

// 실제 진행률이 아니라 그냥 "지금 뭘 하고 있는지" 느낌을 주려고 순환시키는 문구들.
const LOADING_MESSAGES = [
	"먼 곳의 재벌들과 관상을 비교하는 중입니다...",
	"이마 · 눈매 · 코 · 턱선을 하나씩 대조하는 중...",
	"가장 닮은 재벌상을 찾는 중...",
	"관상 카드를 완성하는 중...",
]
let loadingMessageTimer = null

function startLoadingMessages() {
	const el = document.getElementById("loadingStatus")
	if (!el) return
	let i = 0
	el.textContent = LOADING_MESSAGES[0]
	loadingMessageTimer = setInterval(() => {
		i = (i + 1) % LOADING_MESSAGES.length
		el.textContent = LOADING_MESSAGES[i]
	}, 550)
}

function stopLoadingMessages() {
	if (loadingMessageTimer) {
		clearInterval(loadingMessageTimer)
		loadingMessageTimer = null
	}
}

function clearResults() {
	// 결과 리스트 및 평균 유사도 초기화
	document.getElementById("averageResult").textContent = ""
	document.getElementById("aiInfoBadge").textContent = ""
}

/* share function */

async function saveAsImage() {
	const canvas = await captureShareCard()
	const link = document.createElement("a")
	link.href = canvas.toDataURL("image/png")
	link.download = "부자관상분석결과.png"
	link.click()
}

document.getElementById("saveImgBtn").addEventListener("click", async function () {
	playClick()
	await saveAsImage()
})

// 카카오톡/인스타그램/페이스북/X는 위에 전용 버튼이 있으니, 이건 그 목록에 없는 다른 앱
// (왓츠앱/라인/텔레그램 등)으로 보내고 싶을 때 쓰는 보조 옵션 — OS 공유 시트를 그대로 띄운다.
// 데스크톱이나 미지원 브라우저에서는 이미지를 저장한 뒤 알림으로 안내한다.
// 고정 문구("나의 부자 관상 분석 결과!")보다 실제 결과가 들어간 문구가 클릭률이 훨씬
// 높다 — "나는 이재용과 87% 닮은 전략가형?!"처럼 구체적인 숫자·이름·유형이 들어간 문구가
// 스스로 자랑거리가 되어 공유를 유도한다.
function buildShareText() {
	if (!lastResultSummary) return "나의 부자 관상 분석 결과!"
	const { topMatchName, archetypeName, topSimilarity } = lastResultSummary
	if (topMatchName && archetypeName) {
		return `나는 ${topMatchName}과 ${topSimilarity}% 닮은 '${archetypeName}' 관상?! 대한민국 재벌들과 내 관상을 비교해봤다.`
	}
	if (archetypeName) {
		return `나는 재벌 표본과 ${topSimilarity}% 닮은 '${archetypeName}' 관상?! AI로 확인해봤다.`
	}
	return "나의 부자 관상 분석 결과!"
}

// 결과 카드를 캡처해 OS 공유 시트로 보내고, 미지원 브라우저(대부분의 데스크톱)에서는
// 대신 이미지를 저장한 뒤 fallbackMessage로 다음 행동을 안내한다. 공유하기/인스타그램
// 버튼이 "캡처 → 공유 시도 → 실패 시 저장" 흐름을 그대로 공유하고, 안내 문구만 다르다.
async function shareCardOrDownload(fallbackMessage) {
	const canvas = await captureShareCard()
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
	const file = new File([blob], "부자관상분석결과.png", { type: "image/png" })

	if (navigator.canShare && navigator.canShare({ files: [file] })) {
		try {
			await navigator.share({
				files: [file],
				title: "인공지능 부자 관상 테스트",
				text: buildShareText(),
			})
			return
		} catch (err) {
			if (err.name === "AbortError") return // 사용자가 공유를 취소함
			console.warn("공유 실패", err)
		}
	}

	// Web Share API 미지원 → 저장으로 대체
	const link = document.createElement("a")
	link.href = canvas.toDataURL("image/png")
	link.download = "부자관상분석결과.png"
	link.click()
	showToast(fallbackMessage)
}

document.getElementById("webShareBtn").addEventListener("click", async function () {
	playClick()
	await shareCardOrDownload("이 브라우저는 공유 시트를 지원하지 않아 이미지를 저장했습니다. 저장된 이미지를 원하는 앱에 직접 첨부해 공유해주세요.")
})

// 카카오톡/페이스북 공식 공유는 "지금 생성된 카드 이미지"가 아니라 사이트 링크(og:image 고정 이미지)를
// 공유하는 방식이다 — 두 서비스 모두 클라이언트에서 방금 만든 이미지를 즉석 업로드하는 API가 없다.
document.getElementById("fbShareBtn").addEventListener("click", function () {
	playClick()
	const shareUrl = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(location.href)
	window.open(shareUrl, "_blank", "noopener,noreferrer,width=600,height=500")
})

// X(트위터)는 페이스북과 같은 방식 — 웹 인텐트로 "링크+문구"만 공유 가능하고, 방금 만든 카드
// 이미지 자체는 X도 URL 인텐트로 첨부하는 방법이 없다(og:image가 미리보기로 자동 첨부됨).
document.getElementById("xShareBtn").addEventListener("click", function () {
	playClick()
	const shareUrl = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(buildShareText()) + "&url=" + encodeURIComponent(location.href)
	window.open(shareUrl, "_blank", "noopener,noreferrer,width=600,height=500")
})

// 인스타그램은 카카오톡/페이스북/X와 달리 "이 URL 그대로 피드에 올려줘" 하는 웹 공유 방법이
// 아예 없다(공식 API 없음). OS 공유 시트가 지원되면(대부분의 모바일) 거기서 인스타그램을
// 직접 고를 수 있으니 그걸 먼저 시도하고, 안 되면 저장 후 인스타그램 앱에서 직접 올리도록 안내한다.
document.getElementById("instagramShareBtn").addEventListener("click", async function () {
	playClick()
	await shareCardOrDownload("인스타그램은 웹에서 바로 업로드할 수 없어 이미지를 저장했습니다. 인스타그램 앱을 열어 방금 저장한 사진을 선택해 올려주세요.")
})

document.getElementById("kakaoShareBtn").addEventListener("click", function () {
	playClick()
	if (!KAKAO_JS_KEY) {
		showToast("카카오톡 공유는 아직 설정되지 않았습니다. developers.kakao.com에서 JavaScript 키를 발급받아 js/script.js의 KAKAO_JS_KEY에 붙여넣어주세요.")
		return
	}
	if (typeof Kakao === "undefined") {
		showToast("카카오 SDK를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.")
		return
	}
	if (!Kakao.isInitialized()) Kakao.init(KAKAO_JS_KEY)

	Kakao.Share.sendDefault({
		objectType: "feed",
		content: {
			title: "인공지능 부자 관상 테스트",
			description: buildShareText(),
			imageUrl: "https://saramjh.github.io/richChecker/assets/imgs/og-image.jpg",
			link: {
				mobileWebUrl: location.href,
				webUrl: location.href,
			},
		},
		buttons: [
			{
				title: "나도 테스트하기",
				link: { mobileWebUrl: location.href, webUrl: location.href },
			},
		],
	})
})
