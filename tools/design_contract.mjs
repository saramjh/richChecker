import fs from "node:fs"
const css=fs.readFileSync(new URL("../css/style.css",import.meta.url),"utf8")
const js=fs.readFileSync(new URL("../js/script.js",import.meta.url),"utf8")
const need=(x,m)=>{if(!css.includes(x)&&!js.includes(x))throw new Error(m||("missing: "+x))}
for(const x of[
"--type-micro: 0.75rem;","--type-caption: 0.8125rem;","--type-body: 0.875rem;",
"--type-heading: 1.375rem;","--type-hero: clamp(1.5rem, 5vw, 1.75rem);",
"--leading-body: 1.55;","--radius-control: 8px;","--radius-card: 12px;",
"--gold: #d4af37;","--text-muted: #c9b6e4;","--text-faint: #a599c2;","--panel-2: #2d1b4e;",
"--weight-regular: 400;","--weight-medium: 600;","--weight-bold: 700;",
"--tracking-body: 0.02em;","--tracking-emphasis: 0.04em;","--tracking-label: 0.05em;"
])need(x)
const sizes=[...css.matchAll(/font-size\s*:\s*([^;]+);/g)].map(m=>m[1].trim())
const bad=sizes.filter(v=>!(v.startsWith("var(--type-")||v==="inherit"||v==="16px"))
if(bad.length)throw new Error("one-off font-size: "+[...new Set(bad)].join(", "))
const families=[...css.matchAll(/font-family\s*:\s*([^;]+);/g)].map(m=>m[1].trim())
if(families.some(v=>!["var(--font-body)","var(--font-display)"].includes(v)))throw new Error("one-off font family")
const weights=[...css.matchAll(/font-weight\s*:\s*([^;]+);/g)].map(m=>m[1].trim())
if(weights.some(v=>!v.startsWith("var(--weight-")))throw new Error("one-off font weight")
const tracking=[...css.matchAll(/letter-spacing\s*:\s*([^;]+);/g)].map(m=>m[1].trim())
if(tracking.some(v=>!v.startsWith("var(--tracking-")))throw new Error("one-off letter spacing")
if(/(?:^|[;{\n])\s*color\s*:\s*var\(--gold-dim\)/m.test(css))throw new Error("gold-dim is border/decor only")
for(const [x,m] of[
["font-size: var(--type-hero);","H1 hierarchy"],
["min-height: 48px;","primary action height"],
["min-height: 44px;","secondary action height"],
["width: min(300px, 100%);","narrow-screen action width"],
["#window {\n\t\twidth: 100%;","mobile inner width"],
['font-size="12"',"radar label readability"]
])need(x,m)
if(js.includes('font-size="10"'))throw new Error("radar labels regressed below 12px")
const rgb=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255)
const lum=h=>rgb(h).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0)
const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05)
for(const [fg,bg,name] of[["#a599c2","#2d1b4e","faint"],["#c9b6e4","#2d1b4e","muted"],["#d4af37","#2d1b4e","gold"]])if(contrast(fg,bg)<4.5)throw new Error(name+" text contrast below 4.5:1")
console.log("PASS design contract: semantic type, font roles, readable contrast, action sizing, mobile width")
