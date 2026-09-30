import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const index = fs.readFileSync(path.join(root, "index.html"), "utf8")
const script = fs.readFileSync(path.join(root, "js/script.js"), "utf8")
const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8")

function need(haystack, needle, message) { if (!haystack.includes(needle)) throw new Error(message) }
function forbid(haystack, needle, message) { if (haystack.includes(needle)) throw new Error(message) }

need(index, '<link rel="canonical" href="https://saramjh.github.io/richChecker/">', "canonical must stay on the clean product URL")
need(index, 'id="challengeEntry"', "shared-result challenge entry missing")
need(index, 'AI 얼굴 닮은꼴·부자상 테스트', "adjacent intent copy missing")
need(script, 'function buildChallengeUrl()', "challenge URL builder missing")
need(script, 'canonical.searchParams.set("via", "share")', "share attribution parameter missing")
need(script, 'canonical.searchParams.set("match", lastResultSummary.topMatchId)', "public match id missing from challenge URL")
need(script, 'canonical.searchParams.set("score", lastResultSummary.topSimilarity)', "display score missing from challenge URL")
need(script, 'entry_context: entryContext', "entry context attribution missing")
need(script, 'entryContext = "shared_result"', "validated shared entry context missing")
need(script, 'trackEvent("shared_visit"', "shared visit event missing")
need(script, 'trackEvent("shared_visit_upload"', "shared visit upload event missing")
need(script, 'trackEvent("shared_visit_complete"', "shared visit completion event missing")
need(script, 'trackEvent("share_link_created"', "share link event missing")
need(script, 'url: challengeUrl', "native share must carry the challenge URL")
need(script, 'topMatchId: topMatch.id', "result summary must retain a stable public id")
need(sitemap, '<lastmod>2026-09-30</lastmod>', "sitemap freshness marker is stale")

const builderStart = script.indexOf("function buildChallengeUrl()")
const builderEnd = script.indexOf("function trackShareLinkCreated", builderStart)
const builder = script.slice(builderStart, builderEnd)
for (const sensitive of ["uploadedImage", "features", "radar", "landmarks", "dataUrl", "file"]) {
  forbid(builder, sensitive, `challenge URL must not contain photo/biometric state: ${sensitive}`)
}

console.log("PASS growth contract: clean canonical, safe challenge URL, viral funnel attribution, current sitemap")
