// HD Pack Packager
// Packages upscaled PNGs into a single .hdpack file
// Usage: npx tsx scripts/package-hdpack.ts [input_dir] [output_file]

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const INPUT_DIR = process.argv[2] || './upscaled'
const OUTPUT_FILE = process.argv[3] || './diablo-hd.hdpack'

interface HdPackIndex {
  version: number
  scale: number
  totalFiles: number
  files: Record<string, { offset: number; size: number }>
}

function collectFiles(dir: string, base: string = dir): string[] {
  const result: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      result.push(...collectFiles(full, base))
    } else if (entry.endsWith('.png')) {
      result.push(relative(base, full))
    }
  }
  return result.sort()
}

async function main() {
  console.log(`Packaging HD pack from: ${INPUT_DIR}`)
  const files = collectFiles(INPUT_DIR)
  console.log(`Found ${files.length} upscaled files`)

  if (files.length === 0) {
    console.error('No PNG files found. Run upscale.sh first.')
    process.exit(1)
  }

  const index: HdPackIndex = {
    version: 1,
    scale: 4,
    totalFiles: files.length,
    files: {},
  }

  const chunks: Buffer[] = []
  let offset = 0

  for (const relPath of files) {
    const data = readFileSync(join(INPUT_DIR, relPath))
    index.files[relPath] = { offset, size: data.length }
    chunks.push(data)
    offset += data.length
    if (chunks.length % 500 === 0) {
      process.stdout.write(`\r  Packed: ${chunks.length}/${files.length}`)
    }
  }

  // Format: [4 bytes index length][JSON index][concatenated PNG data]
  const indexBuf = Buffer.from(JSON.stringify(index))
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32LE(indexBuf.length)

  const output = Buffer.concat([lenBuf, indexBuf, ...chunks])
  writeFileSync(OUTPUT_FILE, output)

  const sizeMB = (output.length / 1024 / 1024).toFixed(1)
  console.log(`\n\nHD pack created: ${OUTPUT_FILE}`)
  console.log(`  Size: ${sizeMB} MB`)
  console.log(`  Files: ${files.length}`)
  console.log(`  Scale: 4x`)
}

main().catch(console.error)
