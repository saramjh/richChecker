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
	if (topScore < 0.15) return { label: "무표정", score: 1 - topScore }
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

// 메인 카드가 공중에 둥둥 떠 있는 듯한 아이들 애니메이션
if (typeof gsap !== "undefined") {
	gsap.to(".container", {
		y: -10,
		rotationZ: 0.6,
		rotationX: 1.5,
		duration: 2.6,
		repeat: -1,
		yoyo: true,
		ease: "sine.inOut",
	})
}

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
		features: person.features,
		similarity,
	}
}

// z-score 거리를 0~100 유사도로 변환. SIMILARITY_SCALE은 실측 분포로 보정된 값.
const SIMILARITY_SCALE = 14

function similarityFromDistance(distance) {
	return Math.max(0, 100 - distance * SIMILARITY_SCALE)
}

// z-score 거리 계산은 순수 연산이라 62명을 비교해도 수십 ms 안에 끝난다 — 항목별로
// 진행률 %를 업데이트해봐야 브라우저가 리페인트할 틈도 없이 0→100으로 튀어 버벅이는 것처럼
// 보이므로, 진행률 표시는 (아래 showLoadingModal의) 불확정 애니메이션에 맡기고 여기서는
// 계산만 한다.
async function matchAgainstFeatures(uploadedFeatures, embeddingsData, zscoreDistance) {
	const { stats, people } = embeddingsData
	return people.map((entry) => {
		const distance = zscoreDistance(uploadedFeatures, entry.features, stats)
		return toMatch(entry, similarityFromDistance(distance))
	})
}

async function processImage(imageSrc) {
	showLoadingModal()

	try {
		const { computeFeatures, FEATURE_KEYS, FEATURE_LABELS, zscoreDistance, zscoreToPercentile } = await ensureMediapipeModules()
		const [landmarker] = await Promise.all([ensureFaceLandmarker(), loadAgeModel()])

		const uploadedImage = document.getElementById("uploadedImage")
		const detection = landmarker.detect(uploadedImage)
		const landmarks = detection.faceLandmarks && detection.faceLandmarks[0]

		if (!landmarks) {
			alert("사람 얼굴을 포함한 이미지를 선택해주세요.")
			return
		}

		const featureObj = computeFeatures(landmarks, uploadedImage.naturalWidth, uploadedImage.naturalHeight)
		const uploadedFeatures = FEATURE_KEYS.map((k) => featureObj[k])

		const embeddingsData = await loadEmbeddings()
		const matches = await matchAgainstFeatures(uploadedFeatures, embeddingsData, zscoreDistance)

		const blendshapeCategories = detection.faceBlendshapes && detection.faceBlendshapes[0] && detection.faceBlendshapes[0].categories
		const expression = blendshapeCategories ? topExpressionFromBlendshapes(blendshapeCategories) : null

		let age = null
		try {
			const ageDetection = await faceapi.detectSingleFace(uploadedImage, new faceapi.TinyFaceDetectorOptions()).withAgeAndGender()
			if (ageDetection) age = Math.round(ageDetection.age)
		} catch (err) {
			console.warn("나이 추정 실패", err)
		}

		const topMatch = matches.reduce((best, m) => (m.similarity > best.similarity ? m : best))
		const percentiles = (features) => FEATURE_KEYS.map((k, i) => zscoreToPercentile(features[i], embeddingsData.stats.mean[i], embeddingsData.stats.std[i]))

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

		const radar = {
			keys: FEATURE_KEYS,
			labels: FEATURE_KEYS.map((k) => FEATURE_LABELS[k]),
			user: percentiles(uploadedFeatures),
			match: topMatch.features ? percentiles(topMatch.features) : null,
			matchLabel: topMatch.name || "매칭 인물",
			nearestByFeature,
		}

		renderResults(matches, { age, expression }, radar)
	} catch (err) {
		console.error(err)
		alert("분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.")
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
}

function icon(name) {
	return `<svg class="trait-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`
}

// 전통 관상학의 오악/궁(宮) 개념을 빌려온 해석 문구.
// high/mid/low는 재벌 표본 집단 대비 백분위(percentile) 기준.
const FEATURE_READINGS = {
	foreheadRatio: {
		icon: "brain",
		label: "이마 · 초년운",
		high: "재벌 표본 평균보다 이마가 훤칠하게 넓은 편입니다. 어릴 때부터 총명하고 판단이 빠르며, 윗사람의 발탁운이 따르는 재벌상의 이마 비율에 가깝습니다.",
		mid: "재벌 표본과 비슷한 이마 비율입니다. 무난하고 안정적인 초년운을 타고난 재벌형 이마에 가깝습니다.",
		low: "재벌 표본 평균보다 이마가 아담한 편입니다. 신중하게 내실을 다지는 상으로, 재벌들 사이에서도 늦게 크게 트이는 대기만성형에 속합니다.",
	},
	eyeSpacingRatio: {
		icon: "eye",
		label: "눈매 간격 · 대인궁",
		high: "재벌 표본 평균보다 눈 사이가 넓은 편입니다. 마음이 트여있고 포용력이 커, 재벌들 특유의 폭넓은 인맥형 눈매에 가깝습니다.",
		mid: "재벌 표본과 비슷한 눈매 간격입니다. 대인관계에서 균형 잡힌 처세를 보이는 재벌형에 가깝습니다.",
		low: "재벌 표본 평균보다 눈 사이가 좁은 편입니다. 집중력이 뛰어나 한 우물을 깊게 파는 상으로, 창업형 재벌들에게서 종종 보이는 눈매입니다.",
	},
	noseLengthRatio: {
		icon: "gem",
		label: "코 길이 · 재백궁(재물운)",
		high: "관상학에서 코는 재물을 담는 그릇, '재백궁'이라 했습니다. 재벌 표본 평균보다 콧대가 길게 뻗어 있어 재물을 차곡차곡 쌓는 전형적인 재벌 코에 가깝습니다.",
		mid: "재벌 표본과 비슷한 코 길이입니다. 크게 넘치지도 모자라지도 않게 재물을 관리하는 재벌형 재물운입니다.",
		low: "재벌 표본 평균보다 코가 아담한 편입니다. 씀씀이가 시원시원하고 규모보다 실속을 먼저 챙기는 재물운입니다.",
	},
	mouthWidthRatio: {
		icon: "smile",
		label: "입 너비 · 언변궁",
		high: "재벌 표본 평균보다 입이 큼직한 편입니다. 언변이 좋고 배포가 커, 말 한마디로 조직을 움직이는 재벌 특유의 입매에 가깝습니다.",
		mid: "재벌 표본과 비슷한 입 크기입니다. 신뢰감 있는 화법을 구사하는 재벌형 언변궁입니다.",
		low: "재벌 표본 평균보다 입이 아담한 편입니다. 말수는 적지만 한마디 한마디에 무게가 실리는 상입니다.",
	},
	jawRatio: {
		icon: "shieldCheck",
		label: "턱선 · 말년운",
		high: "재벌 표본 평균보다 턱선이 두드러진 편입니다. 뚝심과 추진력이 강해, 관상학에서 말년의 복이 두텁다고 보는 재벌형 턱에 가깝습니다.",
		mid: "재벌 표본과 비슷한 턱선입니다. 안정적으로 목표를 이뤄가는 재벌형 말년운입니다.",
		low: "재벌 표본 평균보다 턱선이 갸름한 편입니다. 유연하고 임기응변에 강한 상입니다.",
	},
	faceAspectRatio: {
		icon: "squareUser",
		label: "얼굴형 · 전체 기질",
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
			// "이 항목은 OOO 회장과 닮았다"는 게 통계적 비교보다 흥미롭다는 피드백 반영 —
			// 핵심 문구로 승격하고, 백분위는 보조 정보로 남긴다.
			const compareText = nearest ? `${nearest.name}${nearest.title ? `(${nearest.title})` : ""}과(와) 가장 비슷함` : percentile >= 50 ? `재벌 표본 대비 상위 ${Math.max(1, 100 - percentile)}%` : `재벌 표본 대비 하위 ${Math.max(1, percentile)}%`
			return `
				<div class="reading-item">
					<div class="reading-head">
						<span class="reading-label">${icon(reading.icon)}${reading.label}</span>
						<span class="reading-compare">${compareText}</span>
					</div>
					<p>${reading[tier]}</p>
				</div>
			`
		})
		.join("")

	return `
		<div id="readingScroll">
			<h4>AI 관상 풀이 — 재벌 표본과의 비교</h4>
			${items}
		</div>
	`
}

// 육각 레이더 차트를 인라인 SVG로 그린다. userScores/matchScores는 0~100 퍼센타일.
function renderRadarChart(labels, userScores, matchScores, matchLabel) {
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

	return `
		<div id="radarChart">
			<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:220px">
				${rings}${axisLines}${matchPolygon}${userPolygon}${axisLabels}
			</svg>
			<div id="radarLegend"><span class="legend-user">● 나</span>${matchScores ? `<span class="legend-match">✦ ${matchLabel}</span>` : ""}</div>
		</div>
	`
}

function renderTopMatch(match, radar) {
	const badges = []
	if (match.rank) badges.push(`<span class="badge">포브스 순위 ${match.rank}위</span>`)
	if (match.netWorth) badges.push(`<span class="badge">자산 ${match.netWorth}</span>`)

	const achievementHtml = match.achievement ? `<p id="topMatchAchievement">${match.achievement}</p>` : ""
	const creditHtml = match.credit ? `<p id="topMatchCredit">사진 출처: <a href="${match.credit.source}" target="_blank" rel="noopener">${match.credit.author}</a> (${match.credit.license})</p>` : ""
	const radarHtml = radar ? renderRadarChart(radar.labels, radar.user, radar.match, radar.matchLabel) : ""

	return `
		<div id="topMatch">
			<div id="topMatchShine"></div>
			<div id="topMatchHeader">
				<span id="topMatchName">${match.name}</span>
				<span id="topMatchHP">일치율 ${match.similarity.toFixed(1)}%</span>
			</div>
			${match.title ? `<div id="topMatchTitle">${match.title}</div>` : ""}
			${badges.length ? `<div id="topMatchBadges">${badges.join("")}</div>` : ""}
			${radarHtml}
			${achievementHtml}
			${creditHtml}
		</div>
	`
}

function renderResults(matches, aiInfo, radar) {
	// 메인 지표는 "가장 닮은 인물과의 일치율" 하나로 통일한다.
	// (예전에는 전체 인물 평균을 헤드라인으로 썼는데, 카드에 뜨는 1위 매칭 %와 숫자가 달라서
	// 헷갈린다는 지적 반영. 사용자는 "100%에 가까울수록 재벌 같다"는 직관적 관례를 기대하므로
	// 그 관례에 맞는 단일 숫자만 크게 보여준다.)
	const topMatch = matches.reduce((best, m) => (m.similarity > best.similarity ? m : best))
	const topSimilarity = topMatch.similarity.toFixed(1)

	const topMatchHtml = topMatch.name ? `<div id="topMatchReveal" class="pending-reveal">${renderTopMatch(topMatch, radar)}</div>` : ""
	const readingHtml = renderFeatureReadings(radar)

	const aiInfoParts = []
	if (aiInfo && aiInfo.age) aiInfoParts.push(`AI 추정 나이 ${aiInfo.age}세`)
	if (aiInfo && aiInfo.expression) aiInfoParts.push(`표정 ${aiInfo.expression.label} ${(aiInfo.expression.score * 100).toFixed(0)}%`)
	const aiInfoHtml = aiInfoParts.length ? `<p id="aiInfo">${aiInfoParts.join(" · ")}</p>` : ""

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
	const similarityMessage = `<span>${tierLabel}</span> ${tierDesc}`

	const divider = `<div class="section-divider"><span></span>✦<span></span></div>`

	// 결과 출력 (헤드라인 %는 0에서 카운트업 애니메이션으로 채워짐)
	document.getElementById("averageResult").innerHTML = `
		<div id="resultRate">
			<h3>나의 관상 분석 결과</h3>
			<span id="richRate" class="bounce">0.0%</span>
			${aiInfoHtml}
			${topMatchHtml ? divider + topMatchHtml : ""}
			${readingHtml ? divider + readingHtml : ""}
			${divider}
			<p>${similarityMessage}</p>
		</div>
	`

	document.getElementById("resultsContainer").style.display = "block"

	const richRateEl = document.getElementById("richRate")
	const topMatchHPEl = document.getElementById("topMatchHP")
	if (typeof gsap !== "undefined") {
		gsap.to(
			{ v: 0 },
			{
				v: parseFloat(topSimilarity),
				duration: 0.9,
				ease: "power2.out",
				delay: 0.15,
				onUpdate: function () {
					richRateEl.textContent = this.targets()[0].v.toFixed(1) + "%"
				},
			},
		)
		if (topMatchHPEl) {
			topMatchHPEl.textContent = "일치율 0.0%"
			gsap.to(
				{ v: 0 },
				{
					v: topMatch.similarity,
					duration: 0.9,
					ease: "power2.out",
					delay: 0.55,
					onUpdate: function () {
						topMatchHPEl.textContent = "일치율 " + this.targets()[0].v.toFixed(1) + "%"
					},
				},
			)
		}
		gsap.from(".reading-item", { opacity: 0, y: 10, duration: 0.4, stagger: 0.07, ease: "power2.out", delay: 0.9 })
		gsap.fromTo(".radar-poly", { scale: 0 }, { scale: 1, duration: 0.7, ease: "elastic.out(1, 0.65)", stagger: 0.12, delay: 0.55 })
	} else {
		richRateEl.textContent = topSimilarity + "%"
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

	populateShareCard(topMatch, topSimilarity, tierLabel)
}

// 인스타/페이스북/카카오톡에 공유하기 좋은 4:5 비율 카드(화면엔 안 보임, 캡처 전용)에
// 결과를 채워넣는다. "나 vs 매칭 인물" 사진 비교 포맷이 핵심.
function populateShareCard(topMatch, topSimilarity, tierLabel) {
	const userPhotoSrc = document.getElementById("uploadedImage").src

	document.getElementById("shareCardUserPhoto").src = userPhotoSrc
	document.getElementById("shareCardPercent").textContent = topSimilarity + "%"
	document.getElementById("shareCardTier").textContent = tierLabel

	const photosEl = document.querySelector(".share-card-photos")
	const vsEl = document.querySelector(".share-card-vs")
	const matchBoxEl = document.getElementById("shareCardMatchPhoto").closest(".share-card-photo-box")
	const matchNameEl = document.getElementById("shareCardMatchName")
	const matchNameEl2 = document.getElementById("shareCardMatchName2")
	const matchPhotoEl = document.getElementById("shareCardMatchPhoto")
	const badgesEl = document.getElementById("shareCardBadges")

	if (topMatch.name) {
		matchNameEl.textContent = topMatch.name
		matchNameEl2.textContent = topMatch.name
		matchPhotoEl.src = topMatch.image || ""
		vsEl.style.display = ""
		matchBoxEl.style.display = ""
		photosEl.classList.remove("solo")

		const badges = []
		if (topMatch.rank) badges.push(`<span class="badge">포브스 ${topMatch.rank}위</span>`)
		if (topMatch.netWorth) badges.push(`<span class="badge">${topMatch.netWorth}</span>`)
		badgesEl.innerHTML = badges.join("")
	} else {
		// 매칭된 실명 인물이 없으면 "나 vs 회장님" 비교 없이 내 사진만 중앙에 크게 보여준다
		// (빈 여백이 크게 남지 않도록 사진 박스 자체를 키운다)
		matchNameEl.textContent = "재벌 표본"
		vsEl.style.display = "none"
		matchBoxEl.style.display = "none"
		photosEl.classList.add("solo")
		badgesEl.innerHTML = ""
	}
}

// 저장/공유 버튼이 공용으로 사용할 카드 캡처. #shareCard는 항상 360x450(4:5) 고정 크기라
// scale:3으로 캡처하면 1080x1350 — 인스타그램 피드에 바로 올릴 수 있는 해상도가 된다.
async function captureShareCard() {
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

document.getElementById("reset").addEventListener("click", function () {
	playClick()
	window.location.reload()
})

// 실제 분석이 이보다 빨리 끝나도(MediaPipe는 로컬에서 꽤 빠름) 최소 이만큼은 "안개" 상태를
// 유지한다. 그렇지 않으면 들어오는 애니메이션과 나가는 애니메이션이 서로 충돌해 뚝뚝 끊겨 보인다.
const MIN_LOADING_MS = 900
let loadingStartedAt = 0

// 화면 중앙에서 원(iris)이 확 번지며 화면을 덮는 "순간이동 출발" 연출 + 휘익 효과음.
// (Star Wars식 iris wipe 레퍼런스 — 좌우에서 흐린 패널이 슬라이드하던 예전 방식보다
// 훨씬 또렷하게 "포탈이 열린다"는 느낌을 줌)
// GSAP/Tone이 아직 로드되기 전이거나 로드 실패한 극단적인 경우에도 분석 자체는 막히지 않도록
// 항상 modal을 보이게 만드는 폴백을 먼저 깔아둔다.
function showLoadingModal() {
	loadingStartedAt = Date.now()
	const modal = document.getElementById("loadingModal")
	modal.style.display = "block"
	startLoadingMessages()

	if (typeof gsap === "undefined") return
	playWhoosh("out")
	gsap
		.timeline()
		.fromTo("#uploadedImageContainer", { scale: 1, opacity: 1 }, { scale: 0.5, opacity: 0, duration: 0.22, ease: "power4.in" }, 0)
		.fromTo(modal, { clipPath: "circle(0px at 50% 50%)" }, { clipPath: "circle(150vmax at 50% 50%)", duration: 0.4, ease: "power3.out" }, 0.05)
		.fromTo("#portalFlash", { opacity: 0 }, { opacity: 0.9, duration: 0.12, ease: "power1.out" }, 0.05)
		.to("#portalFlash", { opacity: 0, duration: 0.35, ease: "power2.out" }, 0.17)
		.to(".modal-content", { opacity: 1, duration: 0.2 }, 0.3)
}

// 원이 다시 중앙으로 오므라들며 "먼 곳으로 순간이동해서 도착한" 듯 결과를 드러내는 연출 + 효과음.
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
	await new Promise((resolve) => {
		gsap
			.timeline({
				onComplete: () => {
					modal.style.display = "none"
					gsap.set([modal, "#portalFlash", ".modal-content"], { clearProps: "all" })
					gsap.set("#uploadedImageContainer", { clearProps: "all" })
					resolve()
				},
			})
			.to(".modal-content", { opacity: 0, duration: 0.12 }, 0)
			.fromTo("#portalFlash", { opacity: 0 }, { opacity: 0.9, duration: 0.1 }, 0.12)
			.to("#portalFlash", { opacity: 0, duration: 0.3 }, 0.22)
			.to(modal, { clipPath: "circle(0px at 50% 50%)", duration: 0.35, ease: "power3.in" }, 0.12)
			.fromTo("#uploadedImageContainer", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2)" }, 0.4)
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

// 모바일 OS 공유 시트(카카오톡/인스타그램/페이스북 앱 등에 실제 결과 이미지를 바로 보낼 수 있는
// 사실상 유일한 방법). 데스크톱이나 미지원 브라우저에서는 이미지를 저장한 뒤 알림으로 안내한다.
document.getElementById("webShareBtn").addEventListener("click", async function () {
	playClick()
	const canvas = await captureShareCard()
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
	const file = new File([blob], "부자관상분석결과.png", { type: "image/png" })

	if (navigator.canShare && navigator.canShare({ files: [file] })) {
		try {
			await navigator.share({
				files: [file],
				title: "인공지능 부자 관상 테스트",
				text: "나의 부자 관상 분석 결과!",
			})
			return
		} catch (err) {
			if (err.name === "AbortError") return // 사용자가 공유를 취소함
			console.warn("공유 실패", err)
		}
	}

	// Web Share API 미지원 (대부분의 데스크톱 브라우저) → 저장으로 대체
	const link = document.createElement("a")
	link.href = canvas.toDataURL("image/png")
	link.download = "부자관상분석결과.png"
	link.click()
	alert("이 브라우저는 공유 시트를 지원하지 않아 이미지를 저장했습니다. 저장된 이미지를 원하는 앱에 직접 첨부해 공유해주세요.")
})

// 카카오톡/페이스북 공식 공유는 "지금 생성된 카드 이미지"가 아니라 사이트 링크(og:image 고정 이미지)를
// 공유하는 방식이다 — 두 서비스 모두 클라이언트에서 방금 만든 이미지를 즉석 업로드하는 API가 없다.
document.getElementById("fbShareBtn").addEventListener("click", function () {
	playClick()
	const shareUrl = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(location.href)
	window.open(shareUrl, "_blank", "noopener,noreferrer,width=600,height=500")
})

document.getElementById("kakaoShareBtn").addEventListener("click", function () {
	playClick()
	if (!KAKAO_JS_KEY) {
		alert("카카오톡 공유는 아직 설정되지 않았습니다. developers.kakao.com에서 JavaScript 키를 발급받아 js/script.js의 KAKAO_JS_KEY에 붙여넣어주세요.")
		return
	}
	if (typeof Kakao === "undefined") {
		alert("카카오 SDK를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.")
		return
	}
	if (!Kakao.isInitialized()) Kakao.init(KAKAO_JS_KEY)

	Kakao.Share.sendDefault({
		objectType: "feed",
		content: {
			title: "인공지능 부자 관상 테스트",
			description: "대한민국 재벌들과 나의 관상은 얼마나 비슷할까요? AI로 확인해보세요.",
			imageUrl: "https://saramjh.github.io/richChecker/assets/imgs/male.png",
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
