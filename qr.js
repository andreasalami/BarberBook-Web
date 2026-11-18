// QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1-10 (up to 213 bytes).
// Written here instead of adding a library: the iPhone app uses Core Image, the browser has no built-in generator.
// Verified by decoding with macOS's own QR reader: checks/qr-decode.swift.

const RAW = v => { // data modules of version v, after function patterns
  let r = (16 * v + 128) * v + 64
  if (v >= 2) { const a = Math.floor(v / 7) + 2; r -= (25 * a - 10) * a - 55; if (v >= 7) r -= 36 }
  return r
}
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26] // level M, by version
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]

const mul = (x, y) => { // GF(256) with polynomial 0x11D
  let z = 0
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x }
  return z
}
function divisor(degree) {
  const r = Array(degree).fill(0); r[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { r[j] = mul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1] }
    root = mul(root, 2)
  }
  return r
}
function remainder(data, div) {
  const r = div.map(() => 0)
  for (const b of data) {
    const factor = b ^ r.shift(); r.push(0)
    div.forEach((c, i) => { r[i] ^= mul(c, factor) })
  }
  return r
}

/** Returns a square matrix of booleans (true = dark), without the quiet zone. */
export function qr(text) {
  const bytes = [...new TextEncoder().encode(text)]
  let v = 1
  const capacity = v => Math.floor(RAW(v) / 8) - ECC_PER_BLOCK[v] * BLOCKS[v]
  while (v <= 10 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > capacity(v) * 8) v++
  if (v > 10) throw new Error('Testo troppo lungo per il QR')

  // Data codewords: mode 0100, length, bytes, terminator, padding.
  const bits = []
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1) }
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8))
  const dataLen = capacity(v)
  put(0, Math.min(4, dataLen * 8 - bits.length))
  put(0, (8 - bits.length % 8) % 8)
  for (let pad = 0xec; bits.length < dataLen * 8; pad ^= 0xec ^ 0x11) put(pad, 8)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2))

  // Split into blocks, add error correction, interleave.
  const blocks = BLOCKS[v], eccLen = ECC_PER_BLOCK[v], raw = Math.floor(RAW(v) / 8)
  const shortBlocks = blocks - raw % blocks, shortLen = Math.floor(raw / blocks)
  const div = divisor(eccLen), split = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1)); k += block.length
    const ecc = remainder(block, div)
    if (i < shortBlocks) block.push(0)
    split.push(block.concat(ecc))
  }
  const codewords = []
  for (let i = 0; i < split[0].length; i++)
    split.forEach((b, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) codewords.push(b[i]) })

  // Function patterns.
  const size = v * 4 + 17
  const m = Array.from({ length: size }, () => Array(size).fill(false))
  const fn = Array.from({ length: size }, () => Array(size).fill(false))
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true }
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy))
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
    }
  if (v > 1) {
    const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, pos = [6]
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p)
    pos.forEach((x, i) => pos.forEach((y, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }))
  }
  const format = mask => {
    const d = mask // level M = 00
    let r = d
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537)
    const b = ((d << 10) | r) ^ 0x5412, bit = i => ((b >>> i) & 1) === 1
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  format(0) // reserves the format area before placing data
  if (v >= 7) {
    let r = v
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25)
    const b = (v << 12) | r
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3)
      set(a, c, dark); set(c, a, dark)
    }
  }

  // Data, in two-column zigzag from the bottom right.
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
      if (!fn[y][x] && i < codewords.length * 8) { m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++ }
    }
  }

  // The mask with the lowest penalty, as the standard asks (keeps the code easy to scan).
  const masks = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ]
  const apply = k => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && masks[k](x, y)) m[y][x] = !m[y][x] }
  let best = 0, bestScore = Infinity
  for (let k = 0; k < 8; k++) {
    apply(k); format(k)
    const score = penalty(m)
    if (score < bestScore) { best = k; bestScore = score }
    apply(k) // XOR again = undo
  }
  apply(best); format(best)
  return m
}

function penalty(m) {
  const n = m.length
  let p = 0, dark = 0
  const lines = []
  for (let i = 0; i < n; i++) { lines.push(m[i]); lines.push(m.map(row => row[i])) }
  for (const line of lines) {
    for (let i = 1, run = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++
      else { if (run >= 5) p += run - 2; run = 1 }
    }
    const s = line.map(Number).join('')
    for (const pattern of ['10111010000', '00001011101'])
      for (let k = s.indexOf(pattern); k >= 0; k = s.indexOf(pattern, k + 1)) p += 40
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) dark++
    if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3
  }
  return p + (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10
}

/** PNG data URL, 10 px per module, 4-module white margin. */
export function qrDataURL(text, scale = 10) {
  const m = qr(text), border = 4, px = (m.length + border * 2) * scale
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = px
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px); ctx.fillStyle = '#000'
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale) }))
  return canvas.toDataURL('image/png')
}
