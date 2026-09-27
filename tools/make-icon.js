// 生成应用图标 build/icon.ico（内嵌 256x256 PNG，带抗锯齿）
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function crc32(buf) {
  if (!crc32.table) {
    const t = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    crc32.table = t
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t)
}

function makePNG(size) {
  const ss = 3 // 超采样倍率，用于抗锯齿
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const r = size / 2 - size * 0.03
  const inner = r * 0.42 // 中心白色箭头/圆点半径

  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0
    for (let x = 0; x < size; x++) {
      let accR = 0
      let accG = 0
      let accB = 0
      let accA = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss
          const py = y + (sy + 0.5) / ss
          const d = Math.hypot(px - cx, py - cy)
          if (d <= r) {
            const t = d / r
            let cr = mix(0x6b, 0x3d, t)
            let cg = mix(0x83, 0x55, t)
            let cb = mix(0xff, 0xd6, t)
            // 中心白点
            if (d <= inner) {
              const w = 1 - d / inner
              cr = mix(cr, 255, Math.min(1, w * 1.4))
              cg = mix(cg, 255, Math.min(1, w * 1.4))
              cb = mix(cb, 255, Math.min(1, w * 1.4))
            }
            accR += cr
            accG += cg
            accB += cb
            accA += 255
          }
        }
      }
      const n = ss * ss
      const a = accA / n
      const rAvg = accA > 0 ? accR / (accA / 255) : 0
      const gAvg = accA > 0 ? accG / (accA / 255) : 0
      const bAvg = accA > 0 ? accB / (accA / 255) : 0
      raw[o++] = Math.round(rAvg)
      raw[o++] = Math.round(gAvg)
      raw[o++] = Math.round(bAvg)
      raw[o++] = Math.round(a)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const size = 256
const png = makePNG(size)

// 封装为 ICO（单张 256x256 PNG）
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)

const entry = Buffer.alloc(16)
entry[0] = 0 // 宽 0 表示 256
entry[1] = 0 // 高 0 表示 256
entry[2] = 0
entry[3] = 0
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(6 + 16, 12)

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'icon.ico')
fs.writeFileSync(outPath, Buffer.concat([header, entry, png]))
console.log('已生成图标:', outPath, `(${png.length} bytes PNG)`)
