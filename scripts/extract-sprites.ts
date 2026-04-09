// scripts/extract-sprites.ts
// Extracts all CEL/CL2 sprites from DIABDAT.MPQ as individual PNG frames.
// Usage: npx tsx scripts/extract-sprites.ts [mpq_path] [output_dir]

import { resolve, dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Resolve paths relative to the monorepo root
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const SERVER_PKG = resolve(MONOREPO_ROOT, 'packages', 'server', 'src')

// Dynamic imports from the server package (avoids import path issues with tsx)
async function loadServerModules() {
  const { MpqReader } = await import(
    resolve(SERVER_PKG, 'mpq', 'mpq-reader.ts')
  )
  const { decodeCel } = await import(
    resolve(SERVER_PKG, 'decoders', 'cel-decoder.ts')
  )
  const { decodeCl2 } = await import(
    resolve(SERVER_PKG, 'decoders', 'cl2-decoder.ts')
  )
  const { loadPalette } = await import(
    resolve(SERVER_PKG, 'decoders', 'palette-loader.ts')
  )
  const { renderToPng } = await import(
    resolve(SERVER_PKG, 'decoders', 'image-renderer.ts')
  )
  return { MpqReader, decodeCel, decodeCl2, loadPalette, renderToPng }
}

// --- Configuration ---

const MPQ_PATH = resolve(process.argv[2] ?? resolve(MONOREPO_ROOT, 'DIABDAT.MPQ'))
const OUTPUT_DIR = resolve(process.argv[3] ?? resolve(SCRIPT_DIR, '..', 'extracted'))

// Known sprite widths by path prefix (Diablo 1 convention)
const SPRITE_WIDTHS: ReadonlyArray<readonly [string, number]> = [
  ['ctrlpan', 640],
  ['gendata', 640],
  ['items', 56],
  ['monsters', 96],
  ['towners', 96],
  ['plrgfx', 96],
  ['objects', 96],
  ['missiles', 96],
  ['data', 64],
]

const DEFAULT_WIDTH = 96

// Palette keyword-to-path mapping for automatic palette selection
const PALETTE_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ['town', 'levels\\towndata\\town.pal'],
  ['l1', 'levels\\l1data\\l1.pal'],
  ['l2', 'levels\\l2data\\l2.pal'],
  ['l3', 'levels\\l3data\\l3.pal'],
  ['l4', 'levels\\l4data\\l4.pal'],
]

// --- Pure helper functions ---

function getWidth(filePath: string): number {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  for (const [prefix, width] of SPRITE_WIDTHS) {
    if (normalized.startsWith(prefix)) return width
  }
  return DEFAULT_WIDTH
}

interface PaletteEntry {
  readonly path: string
  readonly palette: { readonly colors: readonly [number, number, number][] }
}

function findPaletteForFile(
  filePath: string,
  palettes: readonly PaletteEntry[],
  defaultPalette: PaletteEntry['palette'],
): PaletteEntry['palette'] {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()

  // Check for cutscene-specific palettes (gendata files often have co-located .pal)
  const baseName = normalized.replace(/\.\w+$/, '')
  const matchingPal = palettes.find(
    p => p.path.replace(/\\/g, '/').toLowerCase().replace(/\.\w+$/, '') === baseName,
  )
  if (matchingPal) return matchingPal.palette

  // Match by keyword
  for (const [keyword, palPath] of PALETTE_KEYWORDS) {
    if (normalized.includes(keyword)) {
      const found = palettes.find(
        p => p.path.toLowerCase() === palPath.toLowerCase(),
      )
      if (found) return found.palette
    }
  }

  return defaultPalette
}

function buildOutputPath(
  outputDir: string,
  filePath: string,
  frameIndex: number,
): string {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const dir = dirname(normalizedPath)
  const baseName = normalizedPath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'unknown'
  const paddedIndex = String(frameIndex).padStart(3, '0')
  return join(outputDir, dir, `${baseName}_frame${paddedIndex}.png`)
}

// --- Main extraction logic ---

interface ExtractionStats {
  readonly totalFrames: number
  readonly totalErrors: number
  readonly spriteFileCount: number
  readonly paletteCount: number
  readonly processedFiles: readonly string[]
  readonly errorFiles: readonly string[]
}

async function extractAllSprites(): Promise<ExtractionStats> {
  const {
    MpqReader, decodeCel, decodeCl2, loadPalette, renderToPng,
  } = await loadServerModules()

  process.stderr.write(`Opening MPQ: ${MPQ_PATH}\n`)
  const reader = await MpqReader.open(MPQ_PATH)

  try {
    const fileList = reader.getFileList()
    if (fileList.length === 0) {
      throw new Error('MPQ file list is empty. Check that diabdat.lst exists.')
    }
    process.stderr.write(`Found ${fileList.length} files in archive\n`)

    // Load all palettes
    const palFiles = fileList.filter(f => f.toLowerCase().endsWith('.pal'))
    const palettes: PaletteEntry[] = []

    for (const palFile of palFiles) {
      try {
        const data = await reader.extractFile(palFile)
        if (data && data.length >= 768) {
          palettes.push({ path: palFile, palette: loadPalette(data) })
        }
      } catch {
        // Skip unreadable palette files
      }
    }

    process.stderr.write(`Loaded ${palettes.length} palettes\n`)

    // Find default palette (town.pal)
    const defaultPaletteEntry = palettes.find(
      p => p.path.toLowerCase().includes('town.pal'),
    )
    if (!defaultPaletteEntry) {
      throw new Error('Default palette (town.pal) not found in archive')
    }
    const defaultPalette = defaultPaletteEntry.palette

    // Collect sprite files
    const spriteFiles = fileList.filter(f => {
      const ext = f.toLowerCase().split('.').pop()
      return ext === 'cel' || ext === 'cl2'
    })

    process.stderr.write(`Extracting ${spriteFiles.length} sprite files...\n`)

    let totalFrames = 0
    let totalErrors = 0
    const processedFiles: string[] = []
    const errorFiles: string[] = []

    for (const filePath of spriteFiles) {
      try {
        const data = await reader.extractFile(filePath)
        if (!data || data.length === 0) continue

        const ext = filePath.toLowerCase().split('.').pop()
        const width = getWidth(filePath)
        const palette = findPaletteForFile(filePath, palettes, defaultPalette)

        const frames = ext === 'cel'
          ? decodeCel(data, palette, width)
          : decodeCl2(data, palette, width)

        if (frames.length === 0) continue

        for (let i = 0; i < frames.length; i++) {
          const outPath = buildOutputPath(OUTPUT_DIR, filePath, i)
          mkdirSync(dirname(outPath), { recursive: true })
          const png = await renderToPng(frames[i])
          writeFileSync(outPath, png)
          totalFrames++
        }

        processedFiles.push(filePath)
        process.stderr.write(
          `\r  [${processedFiles.length}/${spriteFiles.length}] ${totalFrames} frames | ${filePath}`,
        )
      } catch {
        totalErrors++
        errorFiles.push(filePath)
      }
    }

    process.stderr.write('\n')
    return {
      totalFrames,
      totalErrors,
      spriteFileCount: spriteFiles.length,
      paletteCount: palettes.length,
      processedFiles,
      errorFiles,
    }
  } finally {
    await reader.close()
  }
}

// --- Entry point ---

async function main(): Promise<void> {
  const startTime = Date.now()
  const stats = await extractAllSprites()
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  process.stderr.write(`\nExtraction complete in ${elapsed}s\n`)
  process.stderr.write(`  Sprite files: ${stats.spriteFileCount}\n`)
  process.stderr.write(`  Total frames: ${stats.totalFrames}\n`)
  process.stderr.write(`  Errors: ${stats.totalErrors}\n`)
  process.stderr.write(`  Palettes: ${stats.paletteCount}\n`)

  if (stats.errorFiles.length > 0) {
    process.stderr.write(`  Failed files: ${stats.errorFiles.join(', ')}\n`)
  }

  // Write metadata
  const metadata = {
    totalFrames: stats.totalFrames,
    errors: stats.totalErrors,
    spriteFiles: stats.spriteFileCount,
    palettes: stats.paletteCount,
    processedFiles: stats.processedFiles,
    errorFiles: stats.errorFiles,
    elapsedSeconds: parseFloat(elapsed),
    timestamp: new Date().toISOString(),
  }

  mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(
    join(OUTPUT_DIR, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  )
  process.stderr.write(`  Metadata: ${join(OUTPUT_DIR, 'metadata.json')}\n`)
}

main().catch(err => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
