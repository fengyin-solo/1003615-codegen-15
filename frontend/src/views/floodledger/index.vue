<template>
  <section class="page" data-module="floodledger">
    <header class="page-head">
      <div>
        <h2>汛期通行台账</h2>
        <p class="page-desc">围绕道路编号、通行宽度、最近巡检日、通行状态登记汛期通行台账；重复登记按道路编号只保留一次，禁止通行时同步封锁无人机航线与防火隔离带巡护路线。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出汛期通行台账</button>
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
    </p>

    <form class="filter-bar" @submit.prevent="submitLedger">
      <label class="filter-item">
        <span>道路编号</span>
        <input v-model="form.道路编号" placeholder="如 FORE-0001" />
      </label>
      <label class="filter-item">
        <span>通行宽度</span>
        <input v-model="form.通行宽度" placeholder="如 4.5米" />
      </label>
      <label class="filter-item">
        <span>最近巡检日</span>
        <input v-model="form.最近巡检日" type="date" />
      </label>
      <label class="filter-item">
        <span>通行状态</span>
        <select v-model="form.通行状态">
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn primary" type="submit">登记台账</button>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
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
          <td :colspan="columns.length + 2" class="empty-state">暂无汛期通行台账数据，可先在上方登记</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条汛期通行台账记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  registerFloodLedger,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('floodledger')
const columns = ["台账编号", "道路编号", "通行宽度", "最近巡检日", "通行状态"]
const actions = ["恢复正常通行", "标记需维护", "登记施工", "禁止通行"]
const statuses = ["正常通行", "需维护", "正在施工", "禁止通行"]
const stats = [{"label": "台账记录数", "value": 0}, {"label": "禁止通行段数", "value": 0}, {"label": "需维护段数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const form = ref({ 道路编号: '', 通行宽度: '', 最近巡检日: '', 通行状态: statuses[0] })
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitLedger() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = registerFloodLedger({ ...form.value })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  form.value = { 道路编号: '', 通行宽度: '', 最近巡检日: '', 通行状态: statuses[0] }
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '汛期通行台账列表读取失败'
  }
}

onMounted(reload)
</script>
