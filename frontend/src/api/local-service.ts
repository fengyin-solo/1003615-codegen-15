import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveModuleBatch, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const FLOOD_LEDGER_KEY = 'floodledger'
const ROAD_KEY = 'forestroad'
const DRONE_KEY = 'drone'
const FIREBREAK_KEY = 'firebreak'
const BLOCKED_STATUS = '禁止通行'
const DRONE_BLOCKED_STATUS = '航线管制'
const FIREBREAK_BLOCKED_STATUS = '巡护封锁'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === FLOOD_LEDGER_KEY) {
    return transitionFloodLedger(meta, id, action, target)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// 事务落库：任一步失败，道路、航线和待办全部回退，调用方只拿到失败消息。
function persistBatch(batch: Record<string, EntryRow[]>): ActionResult | null {
  try {
    saveModuleBatch(batch)
    return null
  } catch (error) {
    return {
      ok: false,
      message: `落库失败，道路、航线和待办已全部回退：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

// 同步道路主档：台账登记就是一次新巡检，与旧巡检结果冲突时以新记录为准。
function syncRoadStatus(
  batch: Record<string, EntryRow[]>,
  roadCode: string,
  patch: { status: string; width?: string; inspectDate?: string },
): void {
  const roads = [...(batch[ROAD_KEY] ?? listRows(ROAD_KEY))]
  const index = roads.findIndex((row) => String(row['道路编号']) === roadCode)
  if (index < 0) {
    return
  }
  const road: EntryRow = {
    ...roads[index],
    status: patch.status,
    通行状态: patch.status,
    pending: patch.status !== '正常通行',
    abnormal: patch.status === BLOCKED_STATUS,
  }
  if (patch.width) {
    road['通行宽度'] = patch.width
  }
  if (patch.inspectDate) {
    road['最近巡检日'] = patch.inspectDate
  }
  roads[index] = road
  batch[ROAD_KEY] = roads
}

// 禁止通行联动：沿着道路编号定位经过该路段的无人机航线和防火隔离带巡护路线，一并封锁。
function blockRoutesForRoad(batch: Record<string, EntryRow[]>, roadCode: string): void {
  batch[DRONE_KEY] = (batch[DRONE_KEY] ?? listRows(DRONE_KEY)).map((row) => {
    const hit =
      String(row['飞行路线'] ?? '').includes(roadCode) ||
      String(row['飞行区域'] ?? '').includes(roadCode)
    return hit ? { ...row, status: DRONE_BLOCKED_STATUS, pending: true, abnormal: true } : row
  })
  batch[FIREBREAK_KEY] = (batch[FIREBREAK_KEY] ?? listRows(FIREBREAK_KEY)).map((row) => {
    const hit =
      String(row['起止坐标'] ?? '').includes(roadCode) ||
      String(row['所属林区'] ?? '').includes(roadCode)
    return hit ? { ...row, status: FIREBREAK_BLOCKED_STATUS, pending: true, abnormal: true } : row
  })
}

// 台账动作流转：改台账状态的同时同步道路主档，禁止通行时联动封锁航线与巡护路线。
function transitionFloodLedger(
  meta: ModuleMeta,
  id: number,
  action: string,
  target: string,
): ActionResult {
  const ledger = listRows(FLOOD_LEDGER_KEY)
  const index = ledger.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(ledger[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const roadCode = String(ledger[index]['道路编号'] ?? '')
  const nextLedger = [...ledger]
  nextLedger[index] = {
    ...nextLedger[index],
    status: target,
    通行状态: target,
    pending: target !== '正常通行',
    abnormal: target === BLOCKED_STATUS,
  }
  const batch: Record<string, EntryRow[]> = { [FLOOD_LEDGER_KEY]: nextLedger }
  syncRoadStatus(batch, roadCode, { status: target })
  if (target === BLOCKED_STATUS) {
    blockRoutesForRoad(batch, roadCode)
  }
  const failure = persistBatch(batch)
  if (failure) {
    return failure
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 登记汛期通行台账：同一道路编号重复登记只保留一次，新记录覆盖旧巡检结果。
export function registerFloodLedger(input: {
  道路编号: string
  通行宽度: string
  最近巡检日: string
  通行状态: string
}): ActionResult {
  const meta = moduleMeta(FLOOD_LEDGER_KEY)
  const roadCode = input.道路编号.trim()
  if (!roadCode) {
    return { ok: false, message: '道路编号不能为空' }
  }
  if (!meta.statuses.includes(input.通行状态)) {
    return { ok: false, message: `通行状态只能是：${meta.statuses.join('、')}` }
  }
  if (!listRows(ROAD_KEY).some((row) => String(row['道路编号']) === roadCode)) {
    return { ok: false, message: `林区道路里没有登记道路编号 ${roadCode}，请先在林区道路模块登记` }
  }
  const inspectDate = input.最近巡检日.trim() || today()
  const width = input.通行宽度.trim()
  const ledger = listRows(FLOOD_LEDGER_KEY)
  const existing = ledger.findIndex((row) => String(row['道路编号']) === roadCode)
  const nextLedger = [...ledger]
  if (existing >= 0) {
    nextLedger[existing] = {
      ...nextLedger[existing],
      status: input.通行状态,
      通行宽度: width || String(nextLedger[existing]['通行宽度'] ?? ''),
      最近巡检日: inspectDate,
      通行状态: input.通行状态,
      pending: input.通行状态 !== '正常通行',
      abnormal: input.通行状态 === BLOCKED_STATUS,
    }
  } else {
    const id = ledger.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    nextLedger.push({
      id,
      status: input.通行状态,
      pending: input.通行状态 !== '正常通行',
      abnormal: input.通行状态 === BLOCKED_STATUS,
      台账编号: `LEDG-${String(id).padStart(4, '0')}`,
      道路编号: roadCode,
      通行宽度: width,
      最近巡检日: inspectDate,
      通行状态: input.通行状态,
    })
  }
  const batch: Record<string, EntryRow[]> = { [FLOOD_LEDGER_KEY]: nextLedger }
  syncRoadStatus(batch, roadCode, { status: input.通行状态, width, inspectDate })
  if (input.通行状态 === BLOCKED_STATUS) {
    blockRoutesForRoad(batch, roadCode)
  }
  const failure = persistBatch(batch)
  if (failure) {
    return failure
  }
  return {
    ok: true,
    message:
      existing >= 0
        ? `道路 ${roadCode} 已有台账，按新登记覆盖旧巡检结果，当前状态「${input.通行状态}」`
        : `道路 ${roadCode} 已登记汛期通行台账，当前状态「${input.通行状态}」`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
