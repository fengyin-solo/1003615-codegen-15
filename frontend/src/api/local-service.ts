import {
  BLOCK_SOURCE,
  CONTROL_BLOCKED,
  CONTROL_OPEN,
  ROAD_STATUS_BLOCKED,
  allRows,
  commitAll,
  listRows,
  matchRoadNos,
  resetRows,
  saveRows,
} from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '封闭']

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

// 从路线文本里提取道路编号，道路→航迹就是沿这条既有数据流定位的。
export function linkedRoadNos(routeText: string): string[] {
  return matchRoadNos(routeText)
}

// 按最新道路状态重算航迹（无人机飞行航线）与待办（防火隔离带巡护路线）的管制状态。
// 禁止通行的道路编号命中路线即封锁；解除封闭的道路沿途编号恢复正常。
export function reconcileRouteControl(
  roads: EntryRow[],
  drones: EntryRow[],
  patrols: EntryRow[],
): { drones: EntryRow[]; patrols: EntryRow[] } {
  const blockedRoads = new Set(
    roads
      .filter((row) => String(row.status) === ROAD_STATUS_BLOCKED)
      .map((row) => String(row['道路编号'] ?? '').trim()),
  )

  const sync = (rows: EntryRow[], routeField: string): EntryRow[] =>
    rows.map((row) => {
      const hit = linkedRoadNos(String(row[routeField] ?? '')).filter((no) => blockedRoads.has(no))
      if (hit.length > 0) {
        const blocked: EntryRow = { ...row, 管制状态: CONTROL_BLOCKED }
        blocked[BLOCK_SOURCE] = hit.join('、')
        return blocked
      }
      if (String(row['管制状态'] ?? CONTROL_OPEN) === CONTROL_BLOCKED) {
        const next: EntryRow = { ...row, 管制状态: CONTROL_OPEN }
        delete next[BLOCK_SOURCE]
        return next
      }
      return row
    })

  return { drones: sync(drones, '飞行路线'), patrols: sync(patrols, '巡护路线') }
}

export type RoadLedgerInput = {
  道路编号: string
  道路名称?: string
  起点位置?: string
  终点位置?: string
  道路等级?: string
  通行宽度: string
  建成时间?: string
  最近巡检日: string
  status: string
  通行状态?: string
}

export type RoadLedgerResult = ActionResult & {
  duplicated?: boolean
  superseded?: boolean
  blockedTracks?: number
  blockedPatrols?: number
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// 汛期通行台账登记（同一道路编号重复登记只保留一次）。
// 与旧巡检结果冲突时的仲裁口径：最近巡检日更晚的一次为准；
// 日期相同视为当日重复登记，保留既有记录不覆盖（旧结果已归档）。
// 存量道路缺最近巡检日时按建成时间回填。
// 禁止通行在同一事务里同步封锁无人机飞行航线和防火隔离带巡护路线；
// 任意一环落库失败，道路、航线、待办整体回退。
export function saveRoadLedger(input: RoadLedgerInput): RoadLedgerResult {
  const meta = moduleMeta('forestroad')
  const roadNo = input.道路编号.trim()
  const width = input.通行宽度.trim()
  const inspectDate = input.最近巡检日.trim()
  if (!roadNo) {
    return { ok: false, message: '道路编号不能为空，台账按道路编号定位路段' }
  }
  if (!width) {
    return { ok: false, message: '通行宽度不能为空' }
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(inspectDate)) {
    return { ok: false, message: '最近巡检日需为有效日期（YYYY-MM-DD）' }
  }
  if (!meta.statuses.includes(input.status)) {
    return { ok: false, message: `通行状态必须是：${meta.statuses.join('、')}` }
  }

  const roads = listRows('forestroad')
  const existingIndex = roads.findIndex((row) => String(row['道路编号'] ?? '').trim() === roadNo)
  if (existingIndex >= 0) {
    const existing = roads[existingIndex]
    const oldDate = String(existing['最近巡检日'] ?? '')
    if (oldDate > inspectDate) {
      // 旧巡检结果更晚，旧记录为准，本次登记不入库。
      return {
        ok: false,
        duplicated: true,
        superseded: false,
        message: `道路 ${roadNo} 已有 ${oldDate} 的巡检记录，晚于本次 ${inspectDate}，以较新巡检为准，本次不覆盖`,
      }
    }
    if (oldDate === inspectDate) {
      return {
        ok: false,
        duplicated: true,
        message: `道路 ${roadNo} 在 ${inspectDate} 已登记过，重复登记只保留一次`,
      }
    }
  }

  const builtTime = input.建成时间?.trim() || (existingIndex >= 0 ? String(roads[existingIndex]['建成时间'] ?? '') : '')
  const nextRoads = [...roads]
  let road: EntryRow
  if (existingIndex >= 0) {
    road = {
      ...roads[existingIndex],
      ...Object.fromEntries(
        Object.entries({
          道路名称: input.道路名称?.trim(),
          起点位置: input.起点位置?.trim(),
          终点位置: input.终点位置?.trim(),
          道路等级: input.道路等级?.trim(),
          通行状态: input.通行状态?.trim(),
        }).filter(([, value]) => value),
      ),
      通行宽度: width,
      建成时间: builtTime,
      最近巡检日: inspectDate,
      status: input.status,
      pending: input.status !== meta.statuses[meta.statuses.length - 1],
      abnormal: input.status === ROAD_STATUS_BLOCKED,
    }
    nextRoads[existingIndex] = road
  } else {
    road = {
      id: roads.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
      status: input.status,
      pending: input.status !== meta.statuses[meta.statuses.length - 1],
      abnormal: input.status === ROAD_STATUS_BLOCKED,
      道路编号: roadNo,
      道路名称: input.道路名称?.trim() || roadNo,
      起点位置: input.起点位置?.trim() || '—',
      终点位置: input.终点位置?.trim() || '—',
      道路等级: input.道路等级?.trim() || '未分级',
      通行宽度: width,
      建成时间: builtTime || inspectDate,
      最近巡检日: inspectDate,
      通行状态: input.通行状态?.trim() || input.status,
    }
    nextRoads.push(road)
  }

  const { drones, patrols } = reconcileRouteControl(nextRoads, listRows('drone'), listRows('patrol'))

  try {
    // 道路、航线、待办同一次落库：commitAll 内部失败会抛错，缓存保持旧值，整体回退。
    commitAll({ forestroad: nextRoads, drone: drones, patrol: patrols })
  } catch (error) {
    return {
      ok: false,
      message: `台账保存失败，道路、航线与待办已全部回退：${error instanceof Error ? error.message : '未知存储错误'}`,
    }
  }

  const blockedTracks = drones.filter((row) => row['管制状态'] === CONTROL_BLOCKED).length
  const blockedPatrols = patrols.filter((row) => row['管制状态'] === CONTROL_BLOCKED).length
  const verb = existingIndex >= 0 ? '更新' : '登记'
  return {
    ok: true,
    duplicated: existingIndex >= 0,
    superseded: existingIndex >= 0,
    blockedTracks,
    blockedPatrols,
    message:
      input.status === ROAD_STATUS_BLOCKED
        ? `道路 ${roadNo} 已${verb}为禁止通行；同步封锁航迹 ${blockedTracks} 条、防火隔离带巡护路线 ${blockedPatrols} 条`
        : `道路 ${roadNo} 汛期台账已${verb}，当前状态「${input.status}」，关联航线与巡护路线已恢复核对`,
  }
}

// 台账行内状态流转：最近巡检日记为今天；封闭道路时联动封锁，解除封闭时联动恢复。
export function runRoadAction(id: number, action: string): RoadLedgerResult {
  const meta = moduleMeta('forestroad')
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows('forestroad')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  return saveRoadLedger({
    道路编号: String(row['道路编号'] ?? ''),
    道路名称: String(row['道路名称'] ?? ''),
    起点位置: String(row['起点位置'] ?? ''),
    终点位置: String(row['终点位置'] ?? ''),
    道路等级: String(row['道路等级'] ?? ''),
    通行宽度: String(row['通行宽度'] ?? ''),
    建成时间: String(row['建成时间'] ?? ''),
    最近巡检日: today(),
    status: target,
    通行状态: target === String(row.status) ? String(row['通行状态'] ?? '') : action,
  })
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  // 已被道路禁止通行封锁的航迹/巡护路线，不允许从本入口直接推进，必须等道路解封。
  if ((key === 'drone' || key === 'patrol') && String(rows[index]['管制状态'] ?? '') === CONTROL_BLOCKED) {
    return { ok: false, message: '该路线因关联道路禁止通行已封锁，请先在林区道路台账解除封闭' }
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
  try {
    saveRows(key, next)
  } catch (error) {
    return {
      ok: false,
      message: `保存失败，已回退：${error instanceof Error ? error.message : '未知存储错误'}`,
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
