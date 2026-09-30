import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const css = fs.readFileSync(path.join(root, "css/style.css"), "utf8")
const script = fs.readFileSync(path.join(root, "js/script.js"), "utf8")
const index = fs.readFileSync(path.join(root, "index.html"), "utf8")

function fail(message) { throw new Error(message) }
function requireText(haystack, needle, message) { if (!haystack.includes(needle)) fail(message) }
function forbidText(haystack, needle, message) { if (haystack.includes(needle)) fail(message) }

// Known dead/patch artifacts must not return.
forbidText(script, "function playWhoosh", "dead playWhoosh() returned")
forbidText(script, "whooshNoise", "dead whoosh audio node returned")
forbidText(css, ".step-label", "orphan .step-label rule returned")
forbidText(index, 'id="uploadImage" accept="image/*" style=', "upload visibility leaked back into inline HTML")
forbidText(index, 'id="resultsContainer" style=', "result visibility leaked back into inline HTML")
requireText(css, "--motion-ease-out:", "motion tokens missing")
requireText(css, "#uploadImage {", "upload state has no CSS owner")
requireText(css, "#resultsContainer {", "results state has no CSS owner")
requireText(script, "const MOTION = Object.freeze", "motion policy has no JS owner")
requireText(script, "function prefersReducedMotion()", "reduced-motion policy missing")
requireText(script, "function commitIntroState()", "reset state owner missing")

// Same selector may override inside media/support contexts, but a base selector should have one owner.
function baseRuleCounts(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "")
  const counts = new Map()
  let i = 0, token = "", quote = null
  const stack = []
  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      if (ch === "\\") { token += ch + (text[i + 1] || ""); i += 2; continue }
      if (ch === quote) quote = null
      token += ch; i += 1; continue
    }
    if (ch === '"' || ch === "'") { quote = ch; token += ch; i += 1; continue }
    if (ch === "{") {
      const head = token.trim(); token = ""
      const atRule = head.startsWith("@")
      const inConditional = stack.some((frame) => frame.conditional)
      const conditional = atRule && /^@(media|supports|container|layer|keyframes)/.test(head)
      stack.push({ head, conditional: inConditional || conditional })
      if (!atRule && !inConditional && head) {
        for (const selector of head.split(",").map((x) => x.trim()).filter(Boolean)) {
          counts.set(selector, (counts.get(selector) || 0) + 1)
        }
      }
      i += 1; continue
    }
    if (ch === "}") { stack.pop(); token = ""; i += 1; continue }
    if (ch === ";" && stack.length && !stack.at(-1).head.startsWith("@")) { token = ""; i += 1; continue }
    token += ch; i += 1
  }
  return counts
}

const duplicates = [...baseRuleCounts(css)].filter(([, count]) => count > 1)
if (duplicates.length) fail(`base CSS selector ownership conflict: ${duplicates.map(([s,c]) => `${s} x${c}`).join(", ")}`)

// Assets generated for people must be exactly the assets referenced by current data, no tracked leftovers.
const people = JSON.parse(fs.readFileSync(path.join(root, "data/people.json"), "utf8"))
const jsonText = JSON.stringify(people)
const referenced = new Set([...jsonText.matchAll(/assets\/people\/[^"']+?\.(?:png|jpe?g|webp|svg)/g)].map((m) => m[0]))
const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
const trackedPeople = tracked.filter((file) => /^assets\/people\/.+\.(?:png|jpe?g|webp|svg)$/i.test(file))
const orphanPeople = trackedPeople.filter((file) => !referenced.has(file))
const missingPeople = [...referenced].filter((file) => !fs.existsSync(path.join(root, file)))
if (orphanPeople.length) fail(`orphan people assets: ${orphanPeople.join(", ")}`)
if (missingPeople.length) fail(`missing people assets: ${missingPeople.join(", ")}`)
if (tracked.some((file) => file.endsWith(".DS_Store"))) fail("tracked .DS_Store found")

console.log(`PASS ownership contract: ${trackedPeople.length} people assets, single base CSS ownership, no known dead/patch artifacts`)
