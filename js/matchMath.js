export const SIMILARITY_SCALE = 14
export const MIN_SIMILARITY = 3

export function similarityFromDistance(distance) {
	return Math.max(MIN_SIMILARITY, 100 - distance * SIMILARITY_SCALE)
}

export function displaySimilarity(value) {
	if (!Number.isFinite(value)) throw new TypeError("Similarity must be a finite number")
	return Math.round(Math.max(0, Math.min(100, value)))
}
