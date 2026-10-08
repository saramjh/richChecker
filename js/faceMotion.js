const CONTOURS = [
  [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
  [33, 160, 158, 133, 153, 144, 33],
  [362, 385, 387, 263, 373, 380, 362],
  [61, 40, 37, 0, 267, 270, 291, 321, 314, 17, 84, 91, 61],
  [6, 197, 195, 5, 4, 1],
]
const POINTS = [10, 234, 454, 152, 133, 362, 6, 1, 61, 291, 33, 263, 0, 17]
const NS = "http://www.w3.org/2000/svg"

export function createFaceGeometry(landmarks, width, height) {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return null
  const indices = new Set([...CONTOURS.flat(), ...POINTS])
  if ([...indices].some(i => !Number.isFinite(landmarks?.[i]?.x) || !Number.isFinite(landmarks[i].y))) return null
  const point = i => [landmarks[i].x * width, landmarks[i].y * height]
  const midpoint = (a, b) => a.map((value, i) => (value + b[i]) / 2)
  const segments = [
    [[point(10), midpoint(point(133), point(362))]],
    [[point(133), point(362)]],
    [[point(6), point(1)]],
    [[point(61), point(291)]],
    [[midpoint(point(61), point(291)), point(152)]],
    [[point(234), point(454)], [point(10), point(152)]],
  ]
  const path = points => points.map((p, i) => (i ? "L" : "M") + p.join(" ")).join(" ")
  return {
    width, height,
    contours: CONTOURS.map(indices => path(indices.map(point))),
    points: POINTS.map(index => ({ index, position: point(index) })),
    measurements: segments.map(group => group.map(path)),
  }
}

export function mountFaceMotion(target, geometry, { gsap, reducedMotion = false, cropped = false, transient = false } = {}) {
  if (!target || !geometry) return null
  const svg = document.createElementNS(NS, "svg")
  svg.setAttribute("class", "face-motion")
  svg.setAttribute("viewBox", `0 0 ${geometry.width} ${geometry.height}`)
  svg.setAttribute("preserveAspectRatio", "xMidYMid " + (cropped ? "slice" : "meet"))
  svg.setAttribute("aria-hidden", "true")
  const element = (tag, attrs, parent = svg) => {
    const node = document.createElementNS(NS, tag)
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
    parent.append(node)
    return node
  }
  for (const d of geometry.contours) element("path", { d, class: "face-motion-contour", "vector-effect": "non-scaling-stroke" })
  for (const { index, position: [cx, cy] } of geometry.points) {
    element("circle", { cx, cy, r: Math.min(geometry.width, geometry.height) * 0.006, "data-landmark": index, class: "face-motion-point", "vector-effect": "non-scaling-stroke" })
  }
  geometry.measurements.forEach((paths, index) => {
    const group = element("g", { class: "face-motion-measure", "data-feature": index })
    for (const d of paths) {
      element("path", { d, class: "face-motion-shadow", "vector-effect": "non-scaling-stroke" }, group)
      element("path", { d, class: "face-motion-line", "vector-effect": "non-scaling-stroke" }, group)
    }
  })
  target.append(svg)
  let timeline = null
  if (!reducedMotion && gsap) {
    timeline = gsap.timeline()
    timeline.fromTo(svg.querySelectorAll(".face-motion-point"), { opacity: 0 }, { opacity: 1, duration: 0.18, stagger: 0.009, ease: "sine.out" }, 0)
    for (const [i, path] of [...svg.querySelectorAll(".face-motion-contour")].entries()) {
      const length = path.getTotalLength()
      path.style.strokeDasharray = length
      timeline.fromTo(path, { strokeDashoffset: length }, { strokeDashoffset: 0, duration: 0.4, ease: "power3.inOut" }, 0.05 + i * 0.025)
    }
    for (const [i, group] of [...svg.querySelectorAll(".face-motion-measure")].entries()) {
      for (const path of group.querySelectorAll("path")) {
        const length = path.getTotalLength()
        path.style.strokeDasharray = length
        timeline.fromTo(path, { strokeDashoffset: length }, { strokeDashoffset: 0, duration: 0.3, ease: "power2.out" }, 0.2 + i * 0.045)
      }
    }
    if (transient) timeline.to(svg, { opacity: 0, duration: 0.22, ease: "power1.in", onComplete: () => svg.remove() }, 0.95)
  }
  return {
    svg,
    cancel() { timeline?.kill(); svg.remove() },
  }
}
