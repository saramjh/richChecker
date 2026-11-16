// TIFF decode is isolated from the UI thread. Only the first classic TIFF IFD
// is decoded; metadata sub-IFDs and subsequent pages are intentionally ignored.
importScripts("pako_inflate.min.js?v=20261116-tiff-bounds", "utif.js?v=20261116-tiff-bounds")

const MAX_TIFF_PIXELS = 8_000_000
const MAX_TIFF_DECODE_BYTES = 32 * 1024 * 1024
const MAX_TIFF_IFD_ENTRIES = 256
const MAX_TIFF_SEGMENTS = 4096
const MAX_TIFF_BYTE_METADATA = 1024 * 1024

// UTIF delegates Deflate TIFF strips to pako. Override its unbounded convenience
// API with a streaming output budget and the exact expected strip/tile byte cap.
const boundedInflate = (input, options = {}) => {
  const requested = Number(options.maxOutputLength)
  const maxOutputLength = Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, MAX_TIFF_DECODE_BYTES)
    : MAX_TIFF_DECODE_BYTES
  const output = new Uint8Array(maxOutputLength)
  const inflater = new self.pako.Inflate({ ...options, chunkSize: 16 * 1024 })
  let length = 0
  inflater.onData = (chunk) => {
    if (length + chunk.byteLength > maxOutputLength) throw new Error("TIFF Deflate output budget exceeded")
    output.set(chunk, length)
    length += chunk.byteLength
  }
  const ok = inflater.push(input, true)
  if (!ok || inflater.err) throw new Error(inflater.msg || "Invalid TIFF Deflate stream")
  return output.subarray(0, length)
}
self.pako.inflate = boundedInflate

function preflightFirstIfd(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const little = bytes[0] === 0x49 && bytes[1] === 0x49
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d
  if (!little && !big) throw new Error("Invalid TIFF byte order")
  if (view.getUint16(2, little) !== 42) throw new Error("BigTIFF or invalid TIFF version is not supported")

  const ifdOffset = view.getUint32(4, little)
  if (!Number.isSafeInteger(ifdOffset) || ifdOffset < 8 || ifdOffset + 2 > bytes.byteLength) throw new Error("Invalid TIFF IFD offset")
  const entryCount = view.getUint16(ifdOffset, little)
  if (entryCount < 1 || entryCount > MAX_TIFF_IFD_ENTRIES) throw new Error("TIFF IFD entry budget exceeded")
  const entriesStart = ifdOffset + 2
  const nextIfdOffset = entriesStart + entryCount * 12
  if (nextIfdOffset + 4 > bytes.byteLength) throw new Error("Truncated TIFF IFD")

  const typeSizes = [0, 1, 1, 2, 4, 8, 0, 1, 2, 4, 8, 4, 8]
  const metadataIfdTags = new Set([330, 34665, 37500, 50740])
  for (let index = 0; index < entryCount; index++) {
    const entry = entriesStart + index * 12
    const tag = view.getUint16(entry, little)
    const type = view.getUint16(entry + 2, little)
    const count = view.getUint32(entry + 4, little)
    const itemSize = typeSizes[type] || 0
    if (itemSize) {
      if (!count || !Number.isSafeInteger(count)) throw new Error("Invalid TIFF tag count")
      if ((itemSize === 1 && count > MAX_TIFF_BYTE_METADATA) || (itemSize > 1 && count > MAX_TIFF_SEGMENTS)) {
        throw new Error("TIFF metadata array budget exceeded")
      }
      const valueLength = itemSize * count
      const valueOffset = valueLength <= 4 ? entry + 8 : view.getUint32(entry + 8, little)
      if (!Number.isSafeInteger(valueOffset) || valueOffset < 8 || valueOffset + valueLength > bytes.byteLength) {
        throw new Error("TIFF tag points outside the source file")
      }
    }
    // These are optional metadata trees, not pixel data. Avoid recursive IFDs
    // and unneeded MakerNotes in the browser photo-analysis path.
    if (metadataIfdTags.has(tag)) view.setUint16(entry, 0, little)
  }

  // Only the first page is used. Prevent UTIF.decode from following a page chain.
  view.setUint32(nextIfdOffset, 0, little)
  return { bytes, little }
}

function validateFirstPage(page, bytes) {
  const width = Number(page.t256?.[0])
  const height = Number(page.t257?.[0])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_TIFF_PIXELS) {
    throw new Error("TIFF pixel budget exceeded")
  }

  const bits = Array.from(page.t258 || [], Number)
  const samples = Number(page.t277?.[0] ?? bits.length)
  if (!bits.length || bits.length > 4 || samples !== bits.length || !Number.isSafeInteger(samples) || samples < 1 || samples > 4) {
    throw new Error("Unsupported TIFF samples per pixel")
  }
  if (!bits.every(value => value === bits[0]) || ![1, 2, 4, 8, 16].includes(bits[0])) {
    throw new Error("Unsupported TIFF bit depth")
  }
  const bitsPerPixel = bits[0] * samples
  if (bitsPerPixel > 32) throw new Error("TIFF decoded byte budget exceeded")
  const rowBytes = Math.ceil(width * bitsPerPixel / 8)
  const decodedBytes = rowBytes * height
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 1 || decodedBytes > MAX_TIFF_DECODE_BYTES) {
    throw new Error("TIFF decoded byte budget exceeded")
  }

  const compression = Number(page.t259?.[0] ?? 1)
  if (![1, 5, 8, 32946, 32773].includes(compression)) throw new Error("Unsupported TIFF compression")
  if (compression === 32946) page.t259[0] = 8 // Adobe Deflate uses the same Deflate stream as tag 8
  const photometric = Number(page.t262?.[0] ?? 2)
  if (![0, 1, 2, 3, 5].includes(photometric)) throw new Error("Unsupported TIFF photometric mode")

  const tiled = page.t322 != null || page.t323 != null
  let offsets, byteCounts, expectedSegmentCount
  if (tiled) {
    const tileWidth = Number(page.t322?.[0]), tileHeight = Number(page.t323?.[0])
    if (!Number.isSafeInteger(tileWidth) || !Number.isSafeInteger(tileHeight) || tileWidth < 1 || tileHeight < 1) {
      throw new Error("Invalid TIFF tile dimensions")
    }
    const columns = Math.ceil(width / tileWidth), rows = Math.ceil(height / tileHeight)
    expectedSegmentCount = columns * rows
    const tileBytes = Math.ceil(tileWidth * bitsPerPixel / 8) * tileHeight
    if (!Number.isSafeInteger(expectedSegmentCount) || expectedSegmentCount > MAX_TIFF_SEGMENTS ||
      !Number.isSafeInteger(tileBytes) || tileBytes < 1 || tileBytes > MAX_TIFF_DECODE_BYTES) {
      throw new Error("TIFF tile budget exceeded")
    }
    offsets = page.t324
    byteCounts = page.t325
  } else {
    offsets = page.t273
    byteCounts = page.t279
    const rowsPerStrip = Number(page.t278?.[0] ?? height)
    if (!Number.isSafeInteger(rowsPerStrip) || rowsPerStrip < 1 || rowsPerStrip > height) {
      throw new Error("Invalid TIFF rows per strip")
    }
    expectedSegmentCount = Math.ceil(height / rowsPerStrip)
    if (!Array.isArray(offsets) || offsets.length !== expectedSegmentCount) {
      throw new Error("TIFF strip count does not match image height")
    }
  }

  if (!Array.isArray(offsets) || offsets.length < 1 || offsets.length > MAX_TIFF_SEGMENTS ||
    (tiled && offsets.length !== expectedSegmentCount) ||
    (compression !== 1 || offsets.length > 1) && (!Array.isArray(byteCounts) || byteCounts.length !== offsets.length)) {
    throw new Error("Invalid TIFF strip/tile table")
  }

  for (let index = 0; index < offsets.length; index++) {
    const offset = Number(offsets[index])
    const length = compression === 1 && offsets.length === 1 ? decodedBytes : Number(byteCounts[index])
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 8 || length < 1 || offset + length > bytes.byteLength) {
      throw new Error("TIFF strip/tile points outside the source file")
    }
  }

  return { width, height, bitsPerPixel, rowBytes, decodedBytes, compression, tiled }
}

self.onmessage = ({ data }) => {
  try {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 14 || data.byteLength > 12 * 1024 * 1024) {
      throw new Error("TIFF input exceeded cap")
    }
    const { bytes, little } = preflightFirstIfd(data)
    const pages = UTIF.decode(data)
    if (!pages?.length) throw new Error("No TIFF image page")
    const page = pages[0]
    const { width, height, bitsPerPixel, decodedBytes, tiled } = validateFirstPage(page, bytes)
    // The Deflate decoder must never allocate more than the expected strip/tile.
    // UTIF's target buffer is already dimension-capped by validateFirstPage.
    UTIF.decodeImage(data, page, pages)
    if (!(page.data instanceof Uint8Array) || page.data.byteLength > decodedBytes) throw new Error("Invalid TIFF decoded pixels")
    const rgba = UTIF.toRGBA8(page)
    if (!(rgba instanceof Uint8Array) || rgba.byteLength !== width * height * 4) throw new Error("Invalid TIFF decoded pixels")
    self.postMessage({ ok: true, width, height, pixels: rgba.buffer }, [rgba.buffer])
  } catch {
    self.postMessage({ ok: false })
  }
}
