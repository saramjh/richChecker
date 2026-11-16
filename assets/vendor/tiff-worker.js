// TIFF decode is isolated from the UI thread. This worker reads photo bytes only
// within the browser and enforces dimensions before decompression allocations.
importScripts("pako_inflate.min.js", "utif.js")
const MAX_TIFF_PIXELS = 8_000_000
self.onmessage = ({ data }) => {
  try {
    if (!(data instanceof ArrayBuffer) || data.byteLength > 12 * 1024 * 1024) throw new Error("TIFF input exceeded cap")
    const pages = UTIF.decode(data)
    if (!pages?.length) throw new Error("No TIFF image page")
    const page = pages[0]
    const width = Number(page.t256?.[0]), height = Number(page.t257?.[0])
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width * height > MAX_TIFF_PIXELS) throw new Error("TIFF pixel budget exceeded")
    UTIF.decodeImage(data, page)
    const rgba = UTIF.toRGBA8(page)
    if (!(rgba instanceof Uint8Array) || rgba.byteLength !== width * height * 4) throw new Error("Invalid TIFF decoded pixels")
    self.postMessage({ ok: true, width, height, pixels: rgba.buffer }, [rgba.buffer])
  } catch {
    self.postMessage({ ok: false })
  }
}
