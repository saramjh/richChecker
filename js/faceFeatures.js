// MediaPipe FaceLandmarker의 478개 랜드마크에서 "관상학적" 비율 특징을 뽑아내는 공용 모듈.
// tools/precompute.html(사전계산)과 js/script.js(실시간 분석) 양쪽에서 동일한 로직을 써야
// 매칭 결과가 일관되므로 하나의 모듈로 공유한다.

export const FEATURE_KEYS = ["foreheadRatio", "eyeSpacingRatio", "noseLengthRatio", "mouthWidthRatio", "jawRatio", "faceAspectRatio"]

export const FEATURE_LABELS = {
	foreheadRatio: "이마",
	eyeSpacingRatio: "눈매 간격",
	noseLengthRatio: "코 길이",
	mouthWidthRatio: "입 너비",
	jawRatio: "턱선",
	faceAspectRatio: "얼굴형",
}

// 표준 MediaPipe Face Mesh(468/478포인트) 캐노니컬 인덱스
const LANDMARK = {
	faceLeft: 234,
	faceRight: 454,
	foreheadTop: 10,
	chin: 152,
	leftEyeInner: 133,
	rightEyeInner: 362,
	noseBridge: 6,
	noseTip: 1,
	mouthLeft: 61,
	mouthRight: 291,
}

export function computeFeatures(landmarks, width, height) {
	const point = (i) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height })
	const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
	const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

	const faceLeft = point(LANDMARK.faceLeft)
	const faceRight = point(LANDMARK.faceRight)
	const foreheadTop = point(LANDMARK.foreheadTop)
	const chin = point(LANDMARK.chin)
	const leftEyeInner = point(LANDMARK.leftEyeInner)
	const rightEyeInner = point(LANDMARK.rightEyeInner)
	const noseBridge = point(LANDMARK.noseBridge)
	const noseTip = point(LANDMARK.noseTip)
	const mouthLeft = point(LANDMARK.mouthLeft)
	const mouthRight = point(LANDMARK.mouthRight)

	const faceWidth = dist(faceLeft, faceRight)
	const faceHeight = dist(foreheadTop, chin)
	const eyeMid = mid(leftEyeInner, rightEyeInner)

	return {
		foreheadRatio: dist(foreheadTop, eyeMid) / faceHeight,
		eyeSpacingRatio: dist(leftEyeInner, rightEyeInner) / faceWidth,
		noseLengthRatio: dist(noseBridge, noseTip) / faceHeight,
		mouthWidthRatio: dist(mouthLeft, mouthRight) / faceWidth,
		jawRatio: dist(chin, mid(mouthLeft, mouthRight)) / faceHeight,
		faceAspectRatio: faceHeight / faceWidth,
	}
}

// z-score 정규화 후 유클리드 거리 (인구 평균/표준편차 기준). 항목별 z-score를 ±2로
// 클램프한다(아래 zscoreToPercentile과 같은 기준) — 클램프가 없으면 랜드마크 인식이 살짝
// 흔들린 항목 하나가(예: 각도·표정 때문에 코 길이가 극단값으로 튐) 나머지 5개 항목이 거의
// 똑같아도 전체 거리를 혼자 지배해버려 "가장 닮은 재벌"로 뽑힌 사람인데 일치율이 0.0%로
// 뜨는 모순이 생긴다(실측: 항목 하나만 15표준편차 벗어나도 나머지 5개가 완전히 같은데
// 일치율이 0%로 나옴 — 클램프 적용 시 76%로 정상화됨).
export function zscoreDistance(featuresA, featuresB, stats) {
	let sumSq = 0
	for (let i = 0; i < featuresA.length; i++) {
		const za = Math.max(-2, Math.min(2, (featuresA[i] - stats.mean[i]) / stats.std[i]))
		const zb = Math.max(-2, Math.min(2, (featuresB[i] - stats.mean[i]) / stats.std[i]))
		sumSq += (za - zb) ** 2
	}
	return Math.sqrt(sumSq)
}

// 각 특징의 z-score를 0~100 점수로 변환 (평균=50, ±2표준편차를 0/100으로 클램프)
export function zscoreToPercentile(value, mean, std) {
	const z = (value - mean) / std
	const clamped = Math.max(-2, Math.min(2, z))
	return Math.round(((clamped + 2) / 4) * 100)
}
