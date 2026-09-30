import fs from "node:fs"

async function importSource(url) {
	const source = fs.readFileSync(url, "utf8")
	const dataUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64")
	return import(dataUrl)
}

const { zscoreDistance } = await importSource(new URL("../js/faceFeatures.js", import.meta.url))
const { displaySimilarity, similarityFromDistance } = await importSource(new URL("../js/matchMath.js", import.meta.url))

const data = JSON.parse(fs.readFileSync(new URL("../data/embeddings.json", import.meta.url), "utf8"))
const people = data.people.filter((person) => person.name)

function rank(features) {
	return people
		.map((person) => ({
			person,
			distance: zscoreDistance(features, person.features, data.stats),
		}))
		.sort((left, right) => left.distance - right.distance)
		.slice(0, 3)
}

let perturbationCases = 0
for (const source of people) {
	const baseline = rank(source.features)
	if (baseline[0].person.name !== source.name || baseline[0].distance !== 0) {
		throw new Error("Self-match contract failed for " + source.name)
	}
	if (!(baseline[0].distance <= baseline[1].distance && baseline[1].distance <= baseline[2].distance)) {
		throw new Error("Top-3 ordering failed for " + source.name)
	}
	if (new Set(baseline.map((item) => item.person.name)).size !== 3) {
		throw new Error("Top-3 uniqueness failed for " + source.name)
	}

	for (const item of baseline) {
		const raw = similarityFromDistance(item.distance)
		const shown = displaySimilarity(raw)
		if (!Number.isFinite(raw) || raw < 3 || raw > 100) throw new Error("Raw similarity out of range for " + source.name)
		if (!Number.isInteger(shown) || shown < 3 || shown > 100) throw new Error("Display similarity out of range for " + source.name)
	}

	for (let featureIndex = 0; featureIndex < source.features.length; featureIndex++) {
		for (const sign of [-1, 1]) {
			const perturbed = [...source.features]
			perturbed[featureIndex] += sign * data.stats.std[featureIndex] * 0.05
			const ranked = rank(perturbed)
			perturbationCases++
			if (ranked[0].person.name !== source.name) throw new Error("5%-sigma top-1 retention failed for " + source.name)
			if (!ranked.some((item) => item.person.name === source.name)) throw new Error("5%-sigma top-3 retention failed for " + source.name)
		}
	}
}

const displayCases = [
	[79.49, 79],
	[79.5, 80],
	[99.6, 100],
	[100.4, 100],
	[3, 3],
]
for (const [input, expected] of displayCases) {
	const actual = displaySimilarity(input)
	if (actual !== expected) throw new Error("Display rounding failed: " + input + " -> " + actual + ", expected " + expected)
}

console.log("PASS " + people.length + " identities; " + perturbationCases + " 5%-sigma perturbations; integer similarity display")
