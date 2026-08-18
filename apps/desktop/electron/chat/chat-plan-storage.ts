/**
 * ChatPlanStorage — 对话计划文件存储。
 *
 * 设计：
 *  - 计划存储于 dataDir/plans/{chatId}/{planId}.md；
 *  - planId 与生成该计划的 assistant 消息 ID 一致；
 *  - 执行计划时告知 LLM 文件路径，让其自行读取，避免全量注入导致上下文爆炸；
 *  - 计划状态（pending/executing/completed/failed）通过内存 Map 追踪，不持久化到文件。
 *
 * 路径结构：
 *  dataDir/
 *    plans/
 *      {chatId}/
 *        {planId}.md
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatPlan, ChatPlanStatus } from './chat-types.js'

/** 计划存储目录：dataDir/plans */
function plansDir(dataDir: string): string {
  return join(dataDir, 'plans')
}

/** 单个对话的计划目录：dataDir/plans/{chatId} */
function chatPlansDir(dataDir: string, chatId: string): string {
  return join(plansDir(dataDir), chatId)
}

/** 单个计划文件路径：dataDir/plans/{chatId}/{planId}.md */
function planFilePath(dataDir: string, chatId: string, planId: string): string {
  return join(chatPlansDir(dataDir, chatId), `${planId}.md`)
}

export class ChatPlanStorage {
  /** 计划状态追踪（内存 Map，不持久化）。 */
  private readonly planStatuses = new Map<string, ChatPlanStatus>()

  constructor(private readonly dataDir: string) {}

  /**
   * 保存计划到文件。
   * @param chatId - 对话 ID
   * @param planId - 计划 ID（通常与消息 ID 一致）
   * @param content - Markdown 格式的计划内容
   * @returns 保存后的计划对象
   */
  async savePlan(chatId: string, planId: string, content: string): Promise<ChatPlan> {
    const dir = chatPlansDir(this.dataDir, chatId)
    await mkdir(dir, { recursive: true })
    const filePath = planFilePath(this.dataDir, chatId, planId)
    await writeFile(filePath, content, 'utf-8')
    const plan: ChatPlan = {
      id: planId,
      chatId,
      createdAt: new Date().toISOString(),
      status: 'pending',
      content,
      filePath
    }
    this.planStatuses.set(planId, 'pending')
    return plan
  }

  /**
   * 读取计划文件。
   * @returns 计划对象，文件不存在返回 undefined
   */
  async loadPlan(chatId: string, planId: string): Promise<ChatPlan | undefined> {
    const filePath = planFilePath(this.dataDir, chatId, planId)
    try {
      const content = await readFile(filePath, 'utf-8')
      return {
        id: planId,
        chatId,
        createdAt: new Date().toISOString(), // TODO: 从文件元数据读取
        status: this.planStatuses.get(planId) ?? 'pending',
        content,
        filePath
      }
    } catch {
      return undefined
    }
  }

  /**
   * 列出对话下的所有计划。
   */
  async listPlans(chatId: string): Promise<ChatPlan[]> {
    const dir = chatPlansDir(this.dataDir, chatId)
    try {
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(dir)
      const plans: ChatPlan[] = []
      for (const file of files) {
        if (!file.endsWith('.md')) continue
        const planId = file.slice(0, -3)
        const plan = await this.loadPlan(chatId, planId)
        if (plan) plans.push(plan)
      }
      return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } catch {
      return []
    }
  }

  /**
   * 更新计划状态。
   */
  updatePlanStatus(planId: string, status: ChatPlanStatus): void {
    this.planStatuses.set(planId, status)
  }

  /**
   * 获取计划状态。
   */
  getPlanStatus(planId: string): ChatPlanStatus {
    return this.planStatuses.get(planId) ?? 'pending'
  }

  /**
   * 删除计划文件。
   */
  async deletePlan(chatId: string, planId: string): Promise<void> {
    const filePath = planFilePath(this.dataDir, chatId, planId)
    try {
      await rm(filePath)
      this.planStatuses.delete(planId)
    } catch {
      // 文件不存在也视为成功
    }
  }

  /**
   * 删除对话下的所有计划。
   */
  async deleteChatPlans(chatId: string): Promise<void> {
    const dir = chatPlansDir(this.dataDir, chatId)
    try {
      await rm(dir, { recursive: true })
      // 内存状态中的计划不会被精确清理，因为 planId 不包含 chatId 信息
      // 实际使用中，对话删除后计划也不会再被访问
    } catch {
      // 目录不存在也视为成功
    }
  }
}
