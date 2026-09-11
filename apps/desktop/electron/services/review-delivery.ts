/**
 * Review + Delivery 管线：服务实例化与组装。
 *
 * 从 main.ts "下沉模块实例" 段提取，封装 OCR / Git / Reviewer / Workflow /
 * Delivery / MergeRefresher / TaskCompleter / AtlassianFactory / TraceService
 * 的创建与互联。
 */
import type { Task, TaskStore, SettingResolver, TaskEventSink } from '@task-pipeline/core'
import type { BrowserWindow } from 'electron'
import {
  AtlassianClientFactory,
  DeliveryService,
  GitService,
  MergeStatusRefresher,
  OpenCodeReviewService,
  OpenAICompatReviewer,
  ReviewOrchestrator,
  TaskCompleter,
  TaskWorkflow,
  asReviewer
} from '@task-pipeline/integrations'
import { resolveOcrBinary, createOcrRunner } from '../init/ocr-binary.js'
import { callQoderOrOpenAIReviewer, reviewBlockingLevel } from '../task/task-runner.js'
import { runOperationAgent, taskWorkspace } from '../task/task-lifecycle.js'
import { TraceService } from '../trace/trace-service.js'

export interface ReviewDeliveryDeps {
  store: TaskStore
  dataDir: string
  desktopSink: TaskEventSink
  desktopResolver: SettingResolver
  getMainWindow: () => BrowserWindow | undefined
  /** main.ts 中的 addTaskEvent 闭包（写 store event + emit changed） */
  addTaskEvent: (event: { taskId: string; kind: string; title: string; detail: string }) => void
}

export interface ReviewDeliveryPipeline {
  ocrService: OpenCodeReviewService
  gitService: GitService
  openAIReviewer: OpenAICompatReviewer
  buildReviewOrchestrator: () => ReviewOrchestrator
  taskWorkflow: TaskWorkflow
  deliveryService: DeliveryService
  mergeRefresher: MergeStatusRefresher
  taskCompleter: TaskCompleter
  atlassianFactory: AtlassianClientFactory
  traceService: TraceService
}

export function createReviewDeliveryPipeline(deps: ReviewDeliveryDeps): ReviewDeliveryPipeline {
  const { store, dataDir, desktopSink, desktopResolver, addTaskEvent } = deps

  // ── 基础服务 ──────────────────────────────────────────────────────────────
  const ocrService = new OpenCodeReviewService(resolveOcrBinary(), createOcrRunner())
  const gitService = new GitService()
  const openAIReviewer = new OpenAICompatReviewer(desktopResolver)

  function buildReviewOrchestrator(): ReviewOrchestrator {
    return new ReviewOrchestrator(
      {
        ocr: ocrService,
        git: gitService,
        reviewer: asReviewer(callQoderOrOpenAIReviewer),
        // 以前这里不传，`ReviewOrchestrator` 永远落在默认的 `high`，设置页的「阻断级别」是个死配置。
        reviewBlockingLevel: reviewBlockingLevel()
      },
      desktopSink
    )
  }

  // ── 任务工作流 ────────────────────────────────────────────────────────────
  const taskWorkflow = new TaskWorkflow(store, desktopResolver, desktopSink, taskWorkspace)

  // ── 交付管线 ──────────────────────────────────────────────────────────────
  const deliveryStepLabels: Record<'commit' | 'push' | 'merge_request', string> = {
    commit: '提交代码',
    push: '推送分支',
    merge_request: '创建 Merge Request'
  }

  async function deliveryApprover(
    task: Task,
    kind: 'commit' | 'push' | 'merge_request',
    context: string
  ): Promise<boolean> {
    // 不再弹框：固定链路下交付动作已由 `mrAutoSubmit` 定位——
    // 自动档由 `advanceAfterValidation()` 无参与提，手动档则是用户在 `awaiting_commit` 自己按的按钮，
    // 两种情况都不需要再逐 commit / push / MR 问一遍。这里只保留审计记录。
    const approval = store.addApproval({ taskId: task.id, kind, context })
    store.resolveApproval(approval.id, 'approved')
    addTaskEvent({
      taskId: task.id,
      kind: 'permission',
      title: `自动执行${deliveryStepLabels[kind]}`,
      detail: context
    })
    return true
  }

  const deliveryService = new DeliveryService(store, gitService, desktopResolver, desktopSink, {
    approver: deliveryApprover,
    describeMergeRequest: async (task, repo, signal) => {
      const body = [
        `## 任务信息\n${task.title}\n${task.description}`,
        `## 仓库\n${repo.name}`,
        `## 变更文件统计\n${repo.featureBranch ? `分支: ${repo.featureBranch} -> ${repo.baseBranch}` : ''}`,
        '请根据任务信息与变更内容生成清晰的 Merge Request 描述。',
        '输出严格 JSON：',
        '{"commitMessage":"<可选>如果未达 commit 标准可以不填","title":"<MR 标题，简洁概括>","description":"<MR 描述，说明改动背景、内容与影响>"}',
        'description 使用中文。'
      ].join('\n\n')
      const text = await runOperationAgent(task.id, 'mr', body, signal)
      if (!text) throw new Error('MR 描述生成返回空')
      return JSON.parse(text)
    }
  })

  // ── 辅助服务 ──────────────────────────────────────────────────────────────
  const mergeRefresher = new MergeStatusRefresher(store, desktopResolver, desktopSink)
  const taskCompleter = new TaskCompleter(store, desktopSink)
  const atlassianFactory = new AtlassianClientFactory(desktopResolver)
  const traceService = new TraceService(dataDir)

  return {
    ocrService,
    gitService,
    openAIReviewer,
    buildReviewOrchestrator,
    taskWorkflow,
    deliveryService,
    mergeRefresher,
    taskCompleter,
    atlassianFactory,
    traceService
  }
}
