import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [root, ...process.argv.slice(2).map(p => path.resolve(p))];
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "richchecker-fonts-"));
const fonttool = name => process.env.FONTTOOLS_BIN ? path.join(process.env.FONTTOOLS_BIN, name) : name;
const codepoints = new Set(Array.from({ length: 224 }, (_, i) => i + 32));

async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "vendor", "assets", "models"].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(filename);
    else if (/\.(html|js|json)$/.test(entry.name)) {
      for (const char of await fs.readFile(filename, "utf8")) codepoints.add(char.codePointAt(0));
    }
  }
}
for (const target of targets) await collect(target);
const unicodes = [...codepoints].sort((a, b) => a - b).map(n => n.toString(16)).join(",");
const sources = [
  {
    name: "pretendard", output: "pretendard-ui.woff2",
    base: "https://raw.githubusercontent.com/orioncactus/pretendard/v1.3.9",
    file: "packages/pretendard/dist/web/variable/woff2/PretendardVariable.woff2", license: "LICENSE",
  },
  {
    name: "noto-serif-kr", output: "noto-serif-kr-display.woff2", weight: 700,
    base: "https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoserifkr",
    file: "NotoSerifKR%5Bwght%5D.ttf", license: "OFL.txt",
  },
];

try {
  for (const source of sources) {
    const original = path.join(temp, source.name + (source.weight ? ".ttf" : ".woff2"));
    execFileSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "90", source.base + "/" + source.file, "-o", original]);
    let input = original;
    if (source.weight) {
      input = path.join(temp, source.name + "-bold.ttf");
      execFileSync(fonttool("fonttools"), ["varLib.instancer", original, "wght=" + source.weight, "--output", input]);
    }
    const output = path.join(temp, source.output);
    execFileSync(fonttool("pyftsubset"), [input, "--unicodes=" + unicodes, "--flavor=woff2", "--layout-features=*", "--output-file=" + output]);
    const license = execFileSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "30", source.base + "/" + source.license]);
    for (const target of targets) {
      const destination = path.join(target, "assets/fonts");
      await fs.mkdir(destination, { recursive: true });
      await fs.copyFile(output, path.join(destination, source.output));
      await fs.writeFile(path.join(destination, source.name + "-LICENSE.txt"), license);
    }
    console.log(source.output, (await fs.stat(output)).size, "bytes");
  }
  for (const target of targets) {
    await fs.writeFile(path.join(target, "assets/fonts/manifest.json"), JSON.stringify({
      codepoints: [...codepoints].sort((a, b) => a - b),
      sources,
      rebuild: "node tools/build_fonts.mjs /path/to/other-edition (FontTools with Brotli required)",
    }, null, 2));
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
