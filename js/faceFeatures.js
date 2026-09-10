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

// z-score 정규화 후 유클리드 거리 (인구 평균/표준편차 기준)
export function zscoreDistance(featuresA, featuresB, stats) {
	let sumSq = 0
	for (let i = 0; i < featuresA.length; i++) {
		const za = (featuresA[i] - stats.mean[i]) / stats.std[i]
		const zb = (featuresB[i] - stats.mean[i]) / stats.std[i]
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
