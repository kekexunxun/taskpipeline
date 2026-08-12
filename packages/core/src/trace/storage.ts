/**
 * 存储层 —— 接口抽象 + 默认 JSONL 实现。
 *
 * 布局（dataDir/traces/）：
 *   events/<traceId>.jsonl    每行 { op: span_start|span_update|span_end, span }，追加写
 *   info/<traceId>.json       完成时 finalize 的 TraceSummary（列表/仪表盘直接读，不扫大文件）
 *
 * 可切换存储：实现 TraceStorage 接口注入即可（预留 SQLite 后端）。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { AgentSpan, SpanOp, SpanRecord, TraceDashboardStats, TraceSummary } from './types.js'

/** 存储抽象：写入端（埋点/Bus）与查询端（IPC）共用。 */
export interface TraceStorage {
  /** 追加一条 span 生命周期记录（start / update / end，update 为全量快照）。 */
  appendSpan(traceId: string, op: SpanOp, span: AgentSpan): void
  /** Trace 完成：写入预计算摘要（覆盖旧摘要，幂等）。 */
  finalize(traceId: string, summary: TraceSummary): void
  /** 删除一条 trace：移除 info 摘要与 events 原始文件，返回是否删除了文件。 */
  deleteTrace(traceId: string): Promise<boolean>
  /** 详情：读 events 文件，按 spanId 合并快照（保留最后一条），按 sequence 排序。 */
  getTrace(traceId: string): Promise<AgentSpan[] | undefined>
  /** 同步版全量快照：finalize / 重开时聚合完整历史用（含此前已落盘的全部 span）。 */
  loadSpans(traceId: string): AgentSpan[] | undefined
  /** 读单条已 finalize 的摘要（重开 trace 时刷新 running 状态用）；无 info 文件返回 undefined。 */
  readSummary(traceId: string): TraceSummary | undefined
  /** 列表：info/ 完成态 + events/ 无 info 的 running 兜底，按 updatedAt 倒序。 */
  listTraces(): Promise<TraceSummary[]>
  /** 仪表盘统计聚合。 */
  dashboardStats(): Promise<TraceDashboardStats>
}

export function traceRoot(dataDir: string): string {
  return join(dataDir, 'traces')
}

export function traceEventsDir(dataDir: string): string {
  return join(traceRoot(dataDir), 'events')
}

export function traceInfoDir(dataDir: string): string {
  return join(traceRoot(dataDir), 'info')
}

export function traceEventsFile(dataDir: string, traceId: string): string {
  return join(traceEventsDir(dataDir), `${traceId}.jsonl`)
}

export function traceInfoFile(dataDir: string, traceId: string): string {
  return join(traceInfoDir(dataDir), `${traceId}.json`)
}

/** JSONL 默认实现（追加写，失败静默：trace 可用性低于主流程）。 */
export class JsonlTraceStorage implements TraceStorage {
  constructor(private readonly dataDir: string) {}

  appendSpan(traceId: string, op: SpanOp, span: AgentSpan): void {
    try {
      const file = traceEventsFile(this.dataDir, traceId)
      mkdirSync(traceEventsDir(this.dataDir), { recursive: true })
      const record: SpanRecord = { op, span }
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      /* 忽略：trace 写失败不能影响主流程 */
    }
  }

  finalize(traceId: string, summary: TraceSummary): void {
    try {
      mkdirSync(traceInfoDir(this.dataDir), { recursive: true })
      writeFileSync(traceInfoFile(this.dataDir, traceId), JSON.stringify(summary, null, 2), 'utf8')
    } catch {
      /* 忽略 */
    }
  }

  async deleteTrace(traceId: string): Promise<boolean> {
    let removed = false
    for (const file of [traceInfoFile(this.dataDir, traceId), traceEventsFile(this.dataDir, traceId)]) {
      try {
        rmSync(file)
        removed = true
      } catch {
        /* 文件不存在或删除失败：继续尝试另一个 */
      }
    }
    return removed
  }

  async getTrace(traceId: string): Promise<AgentSpan[] | undefined> {
    return this.loadSpans(traceId)
  }

  readSummary(traceId: string): TraceSummary | undefined {
    const file = traceInfoFile(this.dataDir, traceId)
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as TraceSummary
    } catch {
      return undefined
    }
  }

  loadSpans(traceId: string): AgentSpan[] | undefined {
    const file = traceEventsFile(this.dataDir, traceId)
    if (!existsSync(file)) return undefined
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const latest = new Map<string, AgentSpan>()
    for (const line of lines) {
      let record: SpanRecord
      try {
        record = JSON.parse(line) as SpanRecord
      } catch {
        continue
      }
      if (!record.span?.spanId) continue
      // 快照式：update 全量覆盖，保留最后一条
      latest.set(record.span.spanId, record.span)
    }
    const spans = [...latest.values()].sort((a, b) => a.sequence - b.sequence)
    return spans.length > 0 ? spans : undefined
  }

  async listTraces(): Promise<TraceSummary[]> {
    const out: TraceSummary[] = []
    // ① 完成态：info/*.json
    let infoNames: string[] = []
    try {
      infoNames = readdirSync(traceInfoDir(this.dataDir)).filter((name) => name.endsWith('.json'))
    } catch {
      /* 目录不存在 → 无完成 trace */
    }
    for (const name of infoNames) {
      try {
        const summary = JSON.parse(readFileSync(join(traceInfoDir(this.dataDir), name), 'utf8')) as TraceSummary
        out.push(summary)
      } catch {
        /* 坏文件跳过 */
      }
    }
    // ② running 兜底：events/ 下无 info 的文件（可能为崩溃残留或进行中）
    let eventNames: string[] = []
    try {
      eventNames = readdirSync(traceEventsDir(this.dataDir)).filter((name) => name.endsWith('.jsonl'))
    } catch {
      /* 无 events 目录 */
    }
    for (const name of eventNames) {
      const traceId = name.replace(/\.jsonl$/, '')
      if (out.some((s) => s.traceId === traceId)) continue
      const file = join(traceEventsDir(this.dataDir), name)
      try {
        const stat = statSync(file)
        const first = readFirstLine(file)
        out.push({
          traceId,
          kind: 'chat',
          title: traceId,
          status: 'running',
          startedAt: first?.span?.createdAt ?? new Date(stat.mtimeMs).toISOString(),
          spanCount: 0,
          errorCount: 0,
          updatedAt: new Date(stat.mtimeMs).toISOString()
        })
      } catch {
        /* 跳过坏文件 */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async dashboardStats(): Promise<TraceDashboardStats> {
    const summaries = await this.listTraces()
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const weekMs = 7 * dayMs
    const today = summaries.filter((s) => now - Date.parse(s.startedAt) < dayMs)
    const week = summaries.filter((s) => now - Date.parse(s.startedAt) < weekMs)
    const durationSum = week.reduce((acc, s) => acc + (s.durationMs ?? 0), 0)
    const durations = week.filter((s) => s.durationMs !== undefined).length
    const totalCost = summaries.reduce((acc, s) => acc + (s.costUsd ?? 0), 0)
    return {
      todayCount: today.length,
      weekCount: week.length,
      avgDurationMs: durations > 0 ? Math.round(durationSum / durations) : undefined,
      totalCostUsd: totalCost > 0 ? Number(totalCost.toFixed(4)) : undefined,
      // 两态模型下 trace 无 error 状态：口径改为「含错误步骤的 trace 数」。
      errorCount: summaries.filter((s) => s.errorCount > 0).length
    }
  }
}

function readFirstLine(file: string): SpanRecord | undefined {
  const content = readFileSync(file, 'utf8')
  const first = content.split('\n').find(Boolean)
  if (!first) return undefined
  try {
    return JSON.parse(first) as SpanRecord
  } catch {
    return undefined
  }
}
