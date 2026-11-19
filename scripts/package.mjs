#!/usr/bin/env node
/**
 * Gera o pacote da extensão Guard no navegador para download pela tela:
 *   npm run package
 * Sem dependência nem npm: ZIP montado aqui, sem compressão (os arquivos são pequenos e assim o
 * resultado não depende da versão do zlib). Determinístico (data fixa, arquivos em ordem): o teste unitário reconstrói e compara com o arquivo publicado, e
 * falha se alguém mudar a extensão sem gerar o pacote de novo.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE_DIR = join(ROOT, 'src')
export const OUTPUT = join(ROOT, 'dist', 'aiuby-guard-navegador.zip')
const PACKAGE_DIR = 'aiuby-guard-navegador'
// 1980-01-01 00:00, a menor data do formato ZIP.
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

function listFiles(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? listFiles(path) : [path]
    })
    .sort()
}

/** Também usado pelo pacote do proxy de perímetro (scripts/build-guard-perimeter.mjs). */
export function buildZip(sourceDir = SOURCE_DIR, packageDir = PACKAGE_DIR) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const path of listFiles(sourceDir)) {
    const name = Buffer.from(`${packageDir}/${relative(sourceDir, path).split('\\').join('/')}`, 'utf8')
    const data = readFileSync(path)
    const packed = data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // nomes em UTF-8
    local.writeUInt16LE(0, 8) // sem compressão
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, packed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  const entries = centrals.length / 2
  end.writeUInt16LE(entries, 8)
  end.writeUInt16LE(entries, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zip = buildZip()
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, zip)
  console.log(`${relative(ROOT, OUTPUT)}: ${zip.length} bytes`)
}
