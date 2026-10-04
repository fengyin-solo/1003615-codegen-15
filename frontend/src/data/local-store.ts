import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 存量道路迁移：缺最近巡检日（空或不是日期）的按建成时间回填，有改动就返回 true 让调用方落库。
function migrateRows(rows: Record<string, EntryRow[]>): boolean {
  const roads = rows['forestroad']
  if (!Array.isArray(roads)) {
    return false
  }
  let changed = false
  for (const road of roads) {
    const inspected = String(road['最近巡检日'] ?? '').trim()
    const built = String(road['建成日期'] ?? '').trim()
    if (!DATE_PATTERN.test(inspected) && DATE_PATTERN.test(built)) {
      road['最近巡检日'] = built
      changed = true
    }
  }
  return changed
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    migrateRows(fallback)
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    migrateRows(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    if (migrateRows(merged)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    }
    return merged
  } catch {
    migrateRows(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 事务式批量保存：先把整份数据写进 localStorage，成功之后才换内存缓存。
// 任一步失败都会抛错且内存保持原样，调用方看到道路、航线和待办全部回退。
export function saveModuleBatch(batch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...batch }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
