#!/usr/bin/env bun
/**
 * check-i18n-coverage.ts - CI-safe static i18n key coverage check.
 *
 * Scans TypeScript/React sources for literal translation keys used with
 * t(...), i18n.t(...), or i18next.t(...), then verifies those keys exist in
 * en.json. Dynamic keys are intentionally skipped.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir ?? new URL('.', import.meta.url).pathname, '..')
const LOCALE_PATH = join(ROOT, 'packages', 'shared', 'src', 'i18n', 'locales', 'en.json')
const SOURCE_DIRS = ['apps', 'packages'].map((dir) => join(ROOT, dir))
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.next'])

const locale = JSON.parse(readFileSync(LOCALE_PATH, 'utf-8')) as Record<string, string>
const localeKeys = new Set(Object.keys(locale))

function hasLocaleKey(key: string): boolean {
  if (localeKeys.has(key)) return true
  return localeKeys.has(`${key}_one`) || localeKeys.has(`${key}_other`)
}

function extensionOf(file: string): string {
  if (file.endsWith('.tsx')) return '.tsx'
  if (file.endsWith('.ts')) return '.ts'
  return ''
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue

    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      yield* walk(path)
      continue
    }

    if (SOURCE_EXTENSIONS.has(extensionOf(path))) {
      yield path
    }
  }
}

const KEY_PATTERN = /\b(?:t|i18n\.t|i18next\.t)\(\s*(['"`])([^'"`$]+)\1/g

const missing: Array<{ file: string; key: string }> = []
for (const dir of SOURCE_DIRS) {
  for (const file of walk(dir)) {
    const source = readFileSync(file, 'utf-8')
    for (const match of source.matchAll(KEY_PATTERN)) {
      const key = match[2]
      if (!key || hasLocaleKey(key)) continue
      missing.push({ file: relative(ROOT, file), key })
    }
  }
}

if (missing.length) {
  console.error('i18n coverage check failed:')
  for (const { file, key } of missing.slice(0, 50)) {
    console.error(`  ${file}: missing key "${key}"`)
  }
  if (missing.length > 50) {
    console.error(`  ...and ${missing.length - 50} more`)
  }
  process.exit(1)
}

console.log(`i18n coverage OK (${localeKeys.size} English keys checked)`)
