import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

// 道路→航迹的数据流：航迹（无人机飞行路线）与待办（防火隔离带巡护路线）的路线
// 文本里携带道路编号（如 FORE-0004），道路禁止通行时按这个编号同步封锁。
// 每次匹配新建正则，避免全局正则的 lastIndex 在不同调用间串状态。
export const ROAD_NO_PATTERN = 'FORE-\\d{4}'
export function matchRoadNos(text: string): string[] {
  return Array.from(new Set(text.match(new RegExp(ROAD_NO_PATTERN, 'g')) ?? []))
}
export const CONTROL_OPEN = '正常'
export const CONTROL_BLOCKED = '已封锁'
export const BLOCK_SOURCE = '封锁来源'
export const ROAD_STATUS_BLOCKED = '禁止通行'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isFilledDate(value: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(String(value ?? '').trim())
}

// 存量数据迁移：
// 1. 林区道路没有「建成时间」字段的补一个兜底建成时间；
// 2. 存量道路缺最近巡检日的，按建成时间回填（需求明确的历史台账口径）；
// 3. 航迹/巡护路线缺管制状态字段的补「正常」，再按禁止通行道路沿途编号对齐封锁。
function migrate(raw: Record<string, EntryRow[]>): { data: Record<string, EntryRow[]>; changed: boolean } {
  const data = clone(raw)
  let changed = false

  const fallbackBuilt = '2018-01-01'
  for (const row of data.forestroad ?? []) {
    if (!('建成时间' in row)) {
      row['建成时间'] = fallbackBuilt
      changed = true
    }
    if (!isFilledDate(row['最近巡检日']) && isFilledDate(row['建成时间'])) {
      row['最近巡检日'] = row['建成时间']
      changed = true
    }
  }

  const beforeControl = JSON.stringify({ d: data.drone ?? [], p: data.patrol ?? [] })
  for (const key of ['drone', 'patrol'] as const) {
    for (const row of data[key] ?? []) {
      if (String(row['管制状态'] ?? '') === '') {
        row['管制状态'] = CONTROL_OPEN
      }
    }
  }
  const blockedRoads = new Set(
    (data.forestroad ?? [])
      .filter((row) => String(row.status) === ROAD_STATUS_BLOCKED)
      .map((row) => String(row['道路编号'] ?? '').trim()),
  )
  for (const key of ['drone', 'patrol'] as const) {
    const routeField = key === 'drone' ? '飞行路线' : '巡护路线'
    for (const row of data[key] ?? []) {
      const linked = matchRoadNos(String(row[routeField] ?? ''))
      const shouldBlock = linked.some((no) => blockedRoads.has(no))
      if (shouldBlock) {
        if (row['管制状态'] !== CONTROL_BLOCKED) {
          row['管制状态'] = CONTROL_BLOCKED
        }
        const source = linked.filter((no) => blockedRoads.has(no)).join('、')
        if (row[BLOCK_SOURCE] !== source) {
          row[BLOCK_SOURCE] = source
        }
      } else if (row['管制状态'] === CONTROL_BLOCKED || BLOCK_SOURCE in row) {
        row['管制状态'] = CONTROL_OPEN
        delete row[BLOCK_SOURCE]
      }
    }
  }
  const afterControl = JSON.stringify({ d: data.drone ?? [], p: data.patrol ?? [] })
  if (afterControl !== beforeControl) {
    changed = true
  }

  return { data, changed }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = () => clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = fallback()
    const { data, changed } = migrate(seeded)
    if (changed) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    }
    return data
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback(), ...parsed }
    const { data, changed } = migrate(merged)
    if (changed) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    }
    return data
  } catch {
    const seeded = fallback()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
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

// 真正的落库动作：序列化与写入都可能失败（配额超限/存储不可用），
// 任何一步抛错都不能污染内存缓存——调用方按整次事务回退。
function persist(next: Record<string, EntryRow[]>): void {
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...allRows(), [key]: rows })
}

// 整次事务提交：道路、航线、待办在同一次落库里更新；
// 落库失败（序列化或写入抛错）整体回退，内存里的旧数据原封不动。
export function commitAll(patch: Record<string, EntryRow[]>): void {
  persist({ ...allRows(), ...patch })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
