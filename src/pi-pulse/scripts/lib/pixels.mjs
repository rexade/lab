// Does a screenshot show anything? The browser check's DOM test (little text,
// fewer than two visible elements) called every full-screen canvas game blank,
// and a blank page reverts a session. When the DOM looks empty, the pixels
// decide: a picture without a single sharp edge (one flat colour, or a smooth
// gradient) shows a person nothing.
import zlib from 'node:zlib'

// Enough for Chromium's own screenshots: 8-bit, non-interlaced RGB or RGBA.
// Anything else returns null, and the caller keeps the DOM verdict.
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47) return null
  let width = 0
  let height = 0
  let channels = 0
  let supported = false
  const data = []
  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0
      supported = body[8] === 8 && channels > 0 && body[12] === 0
    } else if (type === 'IDAT') {
      data.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (!supported || !width || !height) return null
  const raw = zlib.inflateSync(Buffer.concat(data))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[row + x - channels] : 0
      const b = y ? pixels[row - stride + x] : 0
      const c = y && x >= channels ? pixels[row - stride + x - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[row + x] = (raw[line + x] + predictor) & 0xff
    }
  }
  return { width, height, channels, pixels }
}

// Neighbouring pixels that differ sharply: the outline of text, a shape, a
// sprite. A smooth gradient has none; the straight seam between two flat
// colours (a page background ending) has them on a single row or column.
export function sharpEdges({ width, height, channels, pixels }) {
  const stride = width * channels
  const rows = new Uint8Array(height)
  const columns = new Uint8Array(width)
  let count = 0
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const i = y * stride + x * channels
      const across = Math.abs(pixels[i] - pixels[i + channels]) + Math.abs(pixels[i + 1] - pixels[i + channels + 1]) + Math.abs(pixels[i + 2] - pixels[i + channels + 2])
      const down = Math.abs(pixels[i] - pixels[i + stride]) + Math.abs(pixels[i + 1] - pixels[i + stride + 1]) + Math.abs(pixels[i + 2] - pixels[i + stride + 2])
      if (across > 60 || down > 60) {
        count += 1
        rows[y] = 1
        columns[x] = 1
      }
    }
  }
  const spread = array => array.reduce((sum, value) => sum + value, 0)
  return { count, rows: spread(rows), columns: spread(columns) }
}

// true / false, or null when the picture cannot be read.
export function showsSomething(png) {
  const image = decodePng(png)
  if (!image) return null
  const edges = sharpEdges(image)
  return edges.count >= Math.max(24, image.width * image.height * 0.0001) && edges.rows >= 4 && edges.columns >= 4
}
