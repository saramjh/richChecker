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

// 이미지 클릭 시 파일 업로드 트리거
document.getElementById("uploadedImage").addEventListener("click", function () {
	document.getElementById("uploadImage").click()
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

async function matchAgainstFeatures(uploadedFeatures, embeddingsData, zscoreDistance) {
	const { stats, people } = embeddingsData
	const matches = []
	for (let i = 0; i < people.length; i++) {
		const entry = people[i]
		const distance = zscoreDistance(uploadedFeatures, entry.features, stats)
		matches.push(toMatch(entry, similarityFromDistance(distance)))
		updateLoadingModal(((i + 1) / people.length) * 100)
	}
	return matches
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
		hideLoadingModal()
	}
}

// 전통 관상학의 오악/궁(宮) 개념을 빌려온 해석 문구.
// high/mid/low는 재벌 표본 집단 대비 백분위(percentile) 기준.
const FEATURE_READINGS = {
	foreheadRatio: {
		label: "이마 · 초년운",
		high: "재벌 표본 평균보다 이마가 훤칠하게 넓은 편입니다. 어릴 때부터 총명하고 판단이 빠르며, 윗사람의 발탁운이 따르는 재벌상의 이마 비율에 가깝습니다.",
		mid: "재벌 표본과 비슷한 이마 비율입니다. 무난하고 안정적인 초년운을 타고난 재벌형 이마에 가깝습니다.",
		low: "재벌 표본 평균보다 이마가 아담한 편입니다. 신중하게 내실을 다지는 상으로, 재벌들 사이에서도 늦게 크게 트이는 대기만성형에 속합니다.",
	},
	eyeSpacingRatio: {
		label: "눈매 간격 · 대인궁",
		high: "재벌 표본 평균보다 눈 사이가 넓은 편입니다. 마음이 트여있고 포용력이 커, 재벌들 특유의 폭넓은 인맥형 눈매에 가깝습니다.",
		mid: "재벌 표본과 비슷한 눈매 간격입니다. 대인관계에서 균형 잡힌 처세를 보이는 재벌형에 가깝습니다.",
		low: "재벌 표본 평균보다 눈 사이가 좁은 편입니다. 집중력이 뛰어나 한 우물을 깊게 파는 상으로, 창업형 재벌들에게서 종종 보이는 눈매입니다.",
	},
	noseLengthRatio: {
		label: "코 길이 · 재백궁(재물운)",
		high: "관상학에서 코는 재물을 담는 그릇, '재백궁'이라 했습니다. 재벌 표본 평균보다 콧대가 길게 뻗어 있어 재물을 차곡차곡 쌓는 전형적인 재벌 코에 가깝습니다.",
		mid: "재벌 표본과 비슷한 코 길이입니다. 크게 넘치지도 모자라지도 않게 재물을 관리하는 재벌형 재물운입니다.",
		low: "재벌 표본 평균보다 코가 아담한 편입니다. 씀씀이가 시원시원하고 규모보다 실속을 먼저 챙기는 재물운입니다.",
	},
	mouthWidthRatio: {
		label: "입 너비 · 언변궁",
		high: "재벌 표본 평균보다 입이 큼직한 편입니다. 언변이 좋고 배포가 커, 말 한마디로 조직을 움직이는 재벌 특유의 입매에 가깝습니다.",
		mid: "재벌 표본과 비슷한 입 크기입니다. 신뢰감 있는 화법을 구사하는 재벌형 언변궁입니다.",
		low: "재벌 표본 평균보다 입이 아담한 편입니다. 말수는 적지만 한마디 한마디에 무게가 실리는 상입니다.",
	},
	jawRatio: {
		label: "턱선 · 말년운",
		high: "재벌 표본 평균보다 턱선이 두드러진 편입니다. 뚝심과 추진력이 강해, 관상학에서 말년의 복이 두텁다고 보는 재벌형 턱에 가깝습니다.",
		mid: "재벌 표본과 비슷한 턱선입니다. 안정적으로 목표를 이뤄가는 재벌형 말년운입니다.",
		low: "재벌 표본 평균보다 턱선이 갸름한 편입니다. 유연하고 임기응변에 강한 상입니다.",
	},
	faceAspectRatio: {
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
			const compareText = nearest
				? `${nearest.name}${nearest.title ? `(${nearest.title})` : ""}과(와) 가장 비슷함`
				: percentile >= 50
					? `재벌 표본 대비 상위 ${Math.max(1, 100 - percentile)}%`
					: `재벌 표본 대비 하위 ${Math.max(1, percentile)}%`
			return `
				<div class="reading-item">
					<div class="reading-head">
						<span class="reading-label">${reading.label}</span>
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

	const matchPolygon = matchScores
		? `<polygon points="${labels.map((_, i) => pointAt(matchScores[i], i).join(",")).join(" ")}" fill="rgba(201,180,88,0.18)" stroke="#c9b458" stroke-width="1.5" stroke-dasharray="4,3"/>`
		: ""
	const userPolygon = `<polygon points="${labels.map((_, i) => pointAt(userScores[i], i).join(",")).join(" ")}" fill="rgba(255,90,90,0.28)" stroke="#ff5a5a" stroke-width="1.5"/>`

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
	const creditHtml = match.credit
		? `<p id="topMatchCredit">사진 출처: <a href="${match.credit.source}" target="_blank" rel="noopener">${match.credit.author}</a> (${match.credit.license})</p>`
		: ""
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

	const topMatchHtml = topMatch.name
		? `<div id="topMatchReveal" class="pending-reveal">${renderTopMatch(topMatch, radar)}</div>`
		: ""
	const readingHtml = renderFeatureReadings(radar)

	const aiInfoParts = []
	if (aiInfo && aiInfo.age) aiInfoParts.push(`AI 추정 나이 ${aiInfo.age}세`)
	if (aiInfo && aiInfo.expression) aiInfoParts.push(`표정 ${aiInfo.expression.label} ${(aiInfo.expression.score * 100).toFixed(0)}%`)
	const aiInfoHtml = aiInfoParts.length ? `<p id="aiInfo">${aiInfoParts.join(" · ")}</p>` : ""

	let similarityMessage = ""

	// 조건에 따른 메시지 설정 (topSimilarity 기준: 100%에 가까울수록 "재벌상"이라는
	// 일반적인 직관에 맞춘 등급)
	if (topSimilarity >= 90) {
		similarityMessage = `<span>완벽한 재벌관상</span> 타고난 카리스마와 권력의 상징. 재벌 이미지를 그대로 품은 외모.`
	} else if (topSimilarity >= 80) {
		similarityMessage = `<span>거의 재벌관상</span> 힘과 부를 상징하는 외모, 성공한 사람의 분위기.`
	} else if (topSimilarity >= 70) {
		similarityMessage = `<span>확실한 재벌 느낌</span> 권위와 부유함이 강하게 나타남.`
	} else if (topSimilarity >= 60) {
		similarityMessage = `<span>눈에 띄는 특징</span> 리더십과 자신감이 표출되기 시작.`
	} else if (topSimilarity >= 50) {
		similarityMessage = `<span>잠재력 있음</span> 카리스마나 부유함의 기운이 약간 느껴짐.`
	} else if (topSimilarity >= 40) {
		similarityMessage = `<span>중간 단계</span> 재벌관상과는 약간의 유사성, 하지만 확실하지 않음.`
	} else if (topSimilarity >= 30) {
		similarityMessage = `<span>평범함</span> 특별히 눈에 띄지 않는 인상.`
	} else if (topSimilarity >= 20) {
		similarityMessage = `<span>부족한 요소</span> 자신감이나 권위가 부족한 인상.`
	} else if (topSimilarity >= 10) {
		similarityMessage = `<span>근본적인 차이</span> 재벌 느낌과는 전혀 어울리지 않음.`
	} else {
		similarityMessage = `<span>완전히 반대</span> 재벌과는 거리가 먼 평범한 외모.`
	}

	// 결과 출력
	document.getElementById("averageResult").innerHTML = `
		<div id="resultRate">
			<h3>나의 관상 분석 결과</h3>
			<span id="richRate" class="bounce">${topSimilarity}%</span>
			${aiInfoHtml}
			${topMatchHtml}
			${readingHtml}
			<p>${similarityMessage}</p>
		</div>
	`

	document.getElementById("resultsContainer").style.display = "block"

	const revealEl = document.getElementById("topMatchReveal")
	if (revealEl) {
		// 짧은 대기 후 카드가 팝업되는 연출 (두구두구 효과)
		requestAnimationFrame(() => {
			setTimeout(() => revealEl.classList.add("revealed"), 500)
		})
	}

	const cardEl = document.getElementById("topMatch")
	if (cardEl) initHoloEffect(cardEl)
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
		{ passive: true }
	)
	cardEl.addEventListener("touchend", resetTilt)
}

document.getElementById("reset").addEventListener("click", function () {
	window.location.reload()
})

function showLoadingModal() {
	const modal = document.getElementById("loadingModal")
	modal.style.display = "block"
}

function hideLoadingModal() {
	const modal = document.getElementById("loadingModal")
	modal.style.display = "none"
}

function updateLoadingModal(percentage) {
	const progressBarInner = document.getElementById("progressBarInner")
	progressBarInner.style.width = percentage + "%"
	progressBarInner.textContent = Math.round(percentage) + "%"
}

function clearResults() {
	// 결과 리스트 및 평균 유사도 초기화
	document.getElementById("averageResult").textContent = ""
}

// 모달 닫기
document.querySelectorAll(".close").forEach((element) => {
	element.addEventListener("click", function () {
		const modal = this.parentElement.parentElement
		modal.style.display = "none"
	})
})

//wallPattern
var wallPattern = {
	// Settings
	spacingX: 55,
	spacingY: 35,
	offsetVariance: 13,
	baseRadius: 55,

	// Other Globals
	points: [],
	canvas: null,
	context: null,

	init: function () {
		this.canvas = document.getElementById("canvas")
		this.context = canvas.getContext("2d")
		this.canvas.width = window.innerWidth
		this.canvas.height = window.innerHeight
		this.preparePoints()
		this.createPattern()
	},

	preparePoints: function () {
		var width, height, i, j, k, offsetX, offsetY
		var maxVariance = this.offsetVariance * 2

		// Vertical spacing
		for (i = this.spacingY; i < this.canvas.height; i += this.spacingY) {
			var pointSet = []

			// Horizontal spacing
			for (j = this.spacingX; j < this.canvas.width; j += this.spacingX) {
				offsetX = Math.round(Math.random() * maxVariance - this.offsetVariance)
				offsetY = Math.round(Math.random() * maxVariance - this.offsetVariance)
				var offsetR = Math.round(Math.random() * maxVariance - this.offsetVariance)

				pointSet.push({ x: j + offsetX, y: i + offsetY, radius: this.baseRadius + offsetR })
			}

			this.points.push(this.shuffleArray(pointSet))
		}
	},

	createPattern: function () {
		var i, j, k, currentPoints, currentPoint

		for (i = 0; i < this.points.length; i++) {
			currentPoints = this.points[i]

			for (j = 0; j < currentPoints.length; j++) {
				currentPoint = currentPoints[j]
				for (k = currentPoint.radius; k > 0; k -= 3) {
					this.context.beginPath()
					this.context.arc(currentPoint.x, currentPoint.y, k, 0, Math.PI * 2, true)
					this.context.closePath()
					this.context.fillStyle = "#150c28"
					this.context.strokeStyle = "#3a2a5c"
					this.context.fill()
					this.context.stroke()
				}
			}
		}
	},

	// Shuffle algorithm from: http://stackoverflow.com/questions/962802/is-it-correct-to-use-javascript-array-sort-method-for-shuffling
	shuffleArray: function (array) {
		var tmp,
			current,
			top = array.length

		if (top)
			while (--top) {
				current = Math.floor(Math.random() * (top + 1))
				tmp = array[current]
				array[current] = array[top]
				array[top] = tmp
			}

		return array
	},
}

wallPattern.init()

/* share function */

function saveAsImage() {
	// 업로드 폼/버튼 등은 제외하고 결과 카드만 캡처 (공유 이미지 품질을 위해)
	const container = document.getElementById("resultsContainer")
	const saveButtonWrapper = document.getElementById("saveImg")
	const richRateEl = document.getElementById("richRate")

	const originalWidth = container.offsetWidth
	const originalHeight = container.offsetHeight

	saveButtonWrapper.style.visibility = "hidden"
	// 진입 애니메이션(bounce)이 아직 재생 중이면 캡처 시 텍스트가 겹쳐 보이므로 캡처 직전 정지시킨다
	if (richRateEl) richRateEl.style.animation = "none"
	const revealEl = document.getElementById("topMatchReveal")
	if (revealEl) {
		revealEl.style.transition = "none"
		revealEl.classList.add("revealed")
	}
	// 홀로그래픽 카드가 마우스 틸트 중이었다면 캡처 전에 평평하게 되돌린다
	const cardEl = document.getElementById("topMatch")
	const shineEl = document.getElementById("topMatchShine")
	if (cardEl) cardEl.style.transform = "none"
	if (shineEl) shineEl.style.opacity = "0"

	html2canvas(container, {
		width: originalWidth,
		height: originalHeight,
		scale: 2, // 고해상도 이미지를 위한 스케일 설정
		useCORS: true, // CORS 문제를 해결하기 위해 필요시 추가
	})
		.then(function (canvas) {
			const link = document.createElement("a")
			link.href = canvas.toDataURL("image/png")
			link.download = "부자관상분석결과.png"
			link.click()
		})
		.finally(function () {
			saveButtonWrapper.style.visibility = "visible"
		})
}

document.getElementById("saveImgBtn").addEventListener("click", function () {
	saveAsImage()
})
