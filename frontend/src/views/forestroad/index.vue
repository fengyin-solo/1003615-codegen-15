<template>
  <section class="page" data-module="forestroad">
    <header class="page-head">
      <div>
        <h2>林区道路汛期通行台账</h2>
        <p class="page-desc">
          围绕道路编号、通行宽度、最近巡检日与通行状态登记正常通行、需维护、正在施工、禁止通行路段；
          禁止通行沿道路编号同步封锁无人机航迹与防火隔离带巡护路线，整次落库失败整体回退。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记汛期台账</button>
        <button class="btn" type="button" @click="exportRows">导出道路台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">已封锁无人机航迹：{{ blockedTrackCount }}</span>
      <span class="legend-item">已封锁防火隔离带巡护路线：{{ blockedPatrolCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>道路编号</span>
        <input v-model="filters['道路编号']" placeholder="按道路编号过滤定位，如 FORE-0004" />
      </label>
      <label class="filter-item">
        <span>通行状态</span>
        <select v-model="filters.status">
          <option value="">全部状态</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-blocked': row.status === '禁止通行' }">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openEdit(row)">更新台账</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的道路台账，可先登记汛期台账</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条道路台账记录 · 冲突仲裁：最近巡检日更晚的记录为准，同日保留既有记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
    </footer>

    <div v-if="formOpen" class="modal-mask" @click.self="closeForm">
      <form class="modal-card" @submit.prevent="submitForm">
        <h3 class="modal-title">{{ editingId ? '更新道路台账（重复编号只保留一次）' : '登记汛期通行台账' }}</h3>
        <label v-for="field in formFields" :key="field.key" class="form-item">
          <span>{{ field.label }}{{ field.required ? ' *' : '' }}</span>
          <input
            v-if="field.type !== 'select'"
            v-model="form[field.key]"
            :type="field.type"
            :placeholder="field.placeholder"
          />
          <select v-else v-model="form[field.key]">
            <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
        <p class="form-hint">存量道路缺最近巡检日时，按建成时间自动回填。</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">保存台账</button>
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runRoadAction,
  saveRoadLedger,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('forestroad')
const columns = ['道路编号', '道路名称', '起点位置', '终点位置', '道路等级', '通行宽度', '建成时间', '最近巡检日', '通行状态']
const actions = ['登记正常', '登记维护', '登记施工', '封闭道路']
const statuses = ['正常通行', '需维护', '正在施工', '禁止通行']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})

type FormKey =
  | '道路编号'
  | '道路名称'
  | '起点位置'
  | '终点位置'
  | '道路等级'
  | '通行宽度'
  | '建成时间'
  | '最近巡检日'
  | '通行状态'
  | 'status'
type FormState = Record<FormKey, string>
const emptyForm: FormState = {
  道路编号: '',
  道路名称: '',
  起点位置: '',
  终点位置: '',
  道路等级: '',
  通行宽度: '',
  建成时间: '',
  最近巡检日: '',
  通行状态: '',
  status: '正常通行',
}
const form = ref<FormState>({ ...emptyForm })
const formOpen = ref(false)
const editingId = ref<number | null>(null)

const formFields: { key: FormKey; label: string; type: string; required?: boolean; placeholder?: string }[] = [
  { key: '道路编号', label: '道路编号', type: 'text', required: true, placeholder: '如 FORE-0005' },
  { key: '道路名称', label: '道路名称', type: 'text' },
  { key: '起点位置', label: '起点位置', type: 'text' },
  { key: '终点位置', label: '终点位置', type: 'text' },
  { key: '道路等级', label: '道路等级', type: 'text' },
  { key: '通行宽度', label: '通行宽度', type: 'text', required: true, placeholder: '如 3.5米' },
  { key: '建成时间', label: '建成时间', type: 'date', placeholder: 'YYYY-MM-DD' },
  { key: '最近巡检日', label: '最近巡检日', type: 'date', required: true },
  { key: '通行状态', label: '路况说明', type: 'text', placeholder: '如 局部路基冲刷' },
  { key: 'status', label: '通行状态', type: 'select', required: true },
]

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '路段总数', value: rows.value.length },
  ...statuses.map((status) => ({
    label: status,
    value: rows.value.filter((row) => String(row.status) === status).length,
  })),
])
const blockedTrackCount = computed(() =>
  listRows('drone').filter((row) => String(row['管制状态']) === '已封锁').length,
)
const blockedPatrolCount = computed(() =>
  listRows('patrol').filter((row) => String(row['管制状态']) === '已封锁').length,
)

// 状态下拉与道路编号过滤都在 reload 里处理，不走通用 filterRows 的包含匹配。

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  form.value = { ...emptyForm }
  editingId.value = null
  formOpen.value = true
  errorMessage.value = ''
  noticeMessage.value = ''
}

function openEdit(row: EntryRow) {
  editingId.value = Number(row.id)
  form.value = {
    道路编号: String(row['道路编号'] ?? ''),
    道路名称: String(row['道路名称'] ?? ''),
    起点位置: String(row['起点位置'] ?? ''),
    终点位置: String(row['终点位置'] ?? ''),
    道路等级: String(row['道路等级'] ?? ''),
    通行宽度: String(row['通行宽度'] ?? ''),
    建成时间: String(row['建成时间'] ?? ''),
    最近巡检日: String(row['最近巡检日'] ?? ''),
    通行状态: String(row['通行状态'] ?? ''),
    status: String(row.status),
  }
  formOpen.value = true
}

function closeForm() {
  formOpen.value = false
}

function submitForm() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = saveRoadLedger({
    道路编号: form.value.道路编号,
    道路名称: form.value.道路名称,
    起点位置: form.value.起点位置,
    终点位置: form.value.终点位置,
    道路等级: form.value.道路等级,
    通行宽度: form.value.通行宽度,
    建成时间: form.value.建成时间,
    最近巡检日: form.value.最近巡检日,
    status: form.value.status,
    通行状态: form.value.通行状态,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  formOpen.value = false
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = runRoadAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const roadNo = (filters.value['道路编号'] ?? '').trim()
    const wantedStatus = filters.value.status ?? ''
    const payload = listEntries(meta.key, {})
    let items = payload.items
    if (roadNo) {
      items = items.filter((row) => String(row['道路编号'] ?? '').includes(roadNo))
    }
    if (wantedStatus) {
      items = items.filter((row) => String(row.status) === wantedStatus)
    }
    rows.value = items
    total.value = items.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '林区道路台账读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.row-blocked {
  background: #fef3f2;
}
.notice-text {
  color: #175cd3;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 560px;
  max-height: 86vh;
  overflow: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}
.modal-title {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 15px;
}
.form-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.form-item input,
.form-item select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
}
.form-hint {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.modal-actions {
  grid-column: 1 / -1;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
