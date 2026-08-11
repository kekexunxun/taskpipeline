/**
 * AgentService — 可配置多 Agent 体系的服务层。
 *
 * 背景：
 *  任务执行原本完全依赖通用 LLM 能力，prompt 只有 memoryContext + 任务描述。
 *  本服务引入「Agent」概念：每个 Agent 携带领域系统提示词、工程约定与模型偏好，
 *  通过 `repositoryIds` 白名单绑定仓库；任务执行时为每个关联仓库解析出对应 Agent，
 *  把其指引注入 plan / implementation / test_generation 全阶段 prompt。
 *
 * 设计：
 *  - 配置存 settings key `agentProfiles`（JSON 数组），与 modelProfile 同模式，不新增表；
 *  - `resolveAgentFor(repositoryId, agentId?)`：任务级覆盖（`task.agentProfileId`）优先，
 *    未覆盖时走仓库白名单（多个命中取最近修改），均未命中返回 undefined
 *    （调用方回退内置「通用」Agent，空内容 = 原行为，零配置完全兼容）；
 *  - `resolveRuntime(task, repos)`：计算任务执行路径（qoder / openai）与模型，
 *    优先级链：任务显式 task.qoderModel > primary 仓库 Agent 的 preferredProvider+preferredModel
 *    > 系统全局 modelProfile（返回 undefined 由调用方回退）；
 *  - `resolveAgentContext(task, repos)`：为每个仓库组装「Agent 指引」段（带仓库名前缀），
 *    命中 `wikiIncludePaths` 的 repowiki 文档全文注入；段总长上限 12k chars；
 *    resume（Qoder 真实续接）场景由调用方决定不调用本方法。
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { AGENT_REVIEWER_ID, AGENT_TASK_DISABLED, AGENT_TEST_WRITER_ID, AGENT_MR_WRITER_ID, GENERAL_AGENT_ID, type AgentProfile, type RepoWikiDoc, type Task, type TaskRepository } from "@task-pipeline/core";

const SETTINGS_KEY = "agentProfiles";
/** Agent 指引段总长上限；截断优先级 systemPrompt > engineeringGuidelines > wiki 全文。 */
const SECTION_LIMIT = 12_000;

export type AgentRuntime = {
  provider?: "qoder" | "openai";
  model?: string;
  agent?: AgentProfile;
};

export type AgentContext = {
  sections: string[];
};

function isAgentProfile(value: unknown): value is AgentProfile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.systemPrompt === "string" &&
    Array.isArray(candidate.repositoryIds) &&
    typeof candidate.enabled === "boolean"
  );
}

export function generalAgent(): AgentProfile {
  const now = new Date().toISOString();
  return {
    id: GENERAL_AGENT_ID,
    name: "通用",
    description: "内置兜底 Agent：未绑定自定义 Agent 的仓库使用通用能力执行，行为与未配置 Agent 体系时一致。",
    systemPrompt: "",
    repositoryIds: [],
    enabled: true,
    builtin: true,
    createdAt: now,
    updatedAt: now
  };
}

/** 操作子 agent 类型。 */
export type OperationKind = "review" | "test" | "mr";

const ROLE_AGENT_DEFAULTS: Record<OperationKind, { id: string; name: string; description: string; systemPrompt: string }> = {
  review: {
    id: AGENT_REVIEWER_ID,
    name: "代码审查员",
    description: "系统内置 Code Review 角色 Agent，用户可编辑 systemPrompt 与模型偏好。",
    systemPrompt: [
      "你是一名严格的代码审查员，请按以下规则逐项检查：",
      "Severity: critical (数据丢失 / 安全 / 崩溃) | high (错误) | medium (性能 / 缺失错误处理) | low (风格)",
      "Drop low 除非确实有价值。",
      "只报告可操作的发现，避免无关建议。"
    ].join("\n")
  },
  test: {
    id: AGENT_TEST_WRITER_ID,
    name: "测试用例生成",
    description: "系统内置测试用例生成角色 Agent，用户可编辑 systemPrompt 与模型偏好。",
    systemPrompt: [
      "你是一个测试用例生成 Agent，专为当前 Coding 任务生成最小测试集。",
      "硬性约束：",
      "1. 不得修改任何业务逻辑文件、不得重构、不得调整非测试相关的配置。",
      "2. 仅为本次改动产出可被现有 testCommand 跑通的最小测试集。",
      "3. 若现有 testCommand 不存在或无法识别测试文件，请按仓库常见约定新增。",
      "4. 所有新增文件必须以测试文件后缀结尾，并放到合理的测试目录。",
      "5. 完成后请把测试相关的修改 commit 到当前 feature 分支。"
    ].join("\n")
  },
  mr: {
    id: AGENT_MR_WRITER_ID,
    name: "MR 描述生成",
    description: "系统内置 MR 描述生成角色 Agent，用户可编辑 systemPrompt 与模型偏好。",
    systemPrompt: [
      "你是一个专业的 MR 描述生成器，根据任务信息与变更内容生成清晰的 Merge Request。",
      "请输出 JSON 格式：",
      '- { "commitMessage": "<可选>如果未达 commit 标准可以不填", "title": "<MR 标题，简洁概括>", "description": "<MR 描述，说明改动背景、内容与影响>" }',
      "description 使用中文。"
    ].join("\n")
  }
};

function createRoleAgent(operation: OperationKind): AgentProfile {
  const now = new Date().toISOString();
  const def = ROLE_AGENT_DEFAULTS[operation];
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    systemPrompt: def.systemPrompt,
    repositoryIds: [],
    enabled: true,
    builtin: true,
    createdAt: now,
    updatedAt: now
  };
}

export class AgentService {
  constructor(
    private readonly getSetting: (key: string) => string | undefined,
    private readonly setSetting: (key: string, value: string) => void,
    /** 按仓库列 repowiki 文档（wikiIncludePaths 全文注入用），可选。 */
    private readonly listWikiDocs?: (repositoryId: string) => RepoWikiDoc[]
  ) {}

  list(): AgentProfile[] {
    const raw = this.getSetting(SETTINGS_KEY);
    let profiles: AgentProfile[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        profiles = Array.isArray(parsed) ? parsed.filter(isAgentProfile) : [];
      } catch { /* fall through */ }
    }
    // 确保三个内置角色 Agent 始终存在（用户编辑后持久化保存，启动时自动补齐）
    for (const op of ["review", "test", "mr"] as OperationKind[]) {
      if (!profiles.some((p) => p.id === ROLE_AGENT_DEFAULTS[op].id)) {
        profiles.push(createRoleAgent(op));
      }
    }
    // 补齐 builtin 标记：历史 settings 中保存的角色 Agent 可能因前端 AgentDialog
    // save() 不回写 builtin 字段导致字段丢失（builtin === undefined）。
    // 角色 Agent 的"内置"语义是后端数据契约的一部分，必须在服务端保证可靠。
    const roleIds = new Set([ROLE_AGENT_DEFAULTS.review.id, ROLE_AGENT_DEFAULTS.test.id, ROLE_AGENT_DEFAULTS.mr.id]);
    profiles = profiles.map((profile) => roleIds.has(profile.id) ? { ...profile, builtin: true } : profile);
    return profiles;
  }

  save(profile: AgentProfile): void {
    const profiles = this.list();
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    this.setSetting(SETTINGS_KEY, JSON.stringify(profiles));
  }

  delete(id: string): void {
    // 内置角色 Agent 不可删除
    if ([AGENT_REVIEWER_ID, AGENT_TEST_WRITER_ID, AGENT_MR_WRITER_ID].includes(id)) return;
    this.setSetting(SETTINGS_KEY, JSON.stringify(this.list().filter((item) => item.id !== id)));
  }

  /** 仓库被删除时同步解绑：从所有 Agent 的 repositoryIds 移除该仓库，返回受影响数量。 */
  detachRepository(repositoryId: string): number {
    const profiles = this.list();
    let affected = 0;
    for (const profile of profiles) {
      if (!profile.repositoryIds.includes(repositoryId)) continue;
      profile.repositoryIds = profile.repositoryIds.filter((id) => id !== repositoryId);
      profile.updatedAt = new Date().toISOString();
      affected++;
    }
    if (affected > 0) this.setSetting(SETTINGS_KEY, JSON.stringify(profiles));
    return affected;
  }

  /** 批量导入（导入导出 JSON）：按 id 合并（跳过畸形条目），已存在则覆盖，返回最新列表。 */
  importAll(profiles: AgentProfile[]): AgentProfile[] {
    for (const profile of profiles) if (isAgentProfile(profile)) this.save(profile);
    return this.list();
  }

  /**
   * 仓库 → Agent 解析：
   *  1. `agentId === AGENT_TASK_DISABLED` → undefined（任务级禁用，回退通用能力）；
   *  2. `repoAgentId` 指定（逐仓库覆盖）→ 直接返回该 enabled Agent；
   *  3. `agentId` 指定（任务级覆盖）→ 直接返回该 enabled Agent；
   *  4. 否则按仓库白名单命中（多个取最近修改）；未命中返回 undefined（调用方回退「通用」）。
   */
  resolveAgentFor(repositoryId: string, agentId?: string, repoAgentId?: string): AgentProfile | undefined {
    if (agentId === AGENT_TASK_DISABLED) return undefined;
    if (repoAgentId) return this.list().find((item) => item.id === repoAgentId && item.enabled);
    if (agentId) return this.list().find((item) => item.id === agentId && item.enabled);
    const candidates = this.list().filter((item) => item.enabled && item.repositoryIds.includes(repositoryId));
    if (candidates.length === 0) return undefined;
    return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  /**
   * 计算任务执行路径与模型。
   *
   * 优先级链：
   *  1. 任务显式指定 task.qoderModel → 按 value 前缀路由（`openai:` → OpenAI 路径；
   *     `qoder:` 或无前缀 → Qoder 路径）。模型选择器统一产出 `qoder:xxx` / `openai:<model>`
   *     两种 value，必须按前缀识别 provider，否则用户选了 OpenAI 模型也会被当成
   *     Qoder 模型传给 qodercli（报 `Invalid model "openai:default"`）。
   *  2. primary 仓库 Agent 配置了 preferredProvider + preferredModel → 按 Agent 路由；
   *  3. 均未配置 → provider 返回 undefined，调用方回退系统 modelProfile。
   */
  resolveRuntime(task: Task, repos: TaskRepository[]): AgentRuntime {
    if (task.qoderModel) {
      if (task.qoderModel.startsWith('openai:')) return { provider: 'openai', model: task.qoderModel }
      return { provider: 'qoder', model: task.qoderModel }
    }
    const agent = this.resolveAgentFor(repos[0]?.repositoryId ?? "", task.agentProfileId, task.repoAgentIds?.[repos[0]?.repositoryId ?? ""]);
    if (agent?.preferredProvider && agent.preferredModel) {
      return {
        provider: agent.preferredProvider === "qoder" ? "qoder" : "openai",
        model: agent.preferredModel,
        agent
      };
    }
    return { agent };
  }

  /** 任务模型覆盖：仅当任务显式指定或 Agent 配置了成对的 provider+model 时返回。 */
  resolveModelForTask(task: Task, repos: TaskRepository[]): string | undefined {
    if (task.qoderModel) return task.qoderModel;
    const agent = this.resolveAgentFor(repos[0]?.repositoryId ?? "", task.agentProfileId, task.repoAgentIds?.[repos[0]?.repositoryId ?? ""]);
    if (agent?.preferredProvider && agent.preferredModel) return agent.preferredModel;
    return undefined;
  }

  /**
   * 组装单个 Agent 的指引正文：systemPrompt + engineeringGuidelines + wikiIncludePaths 全文，
   * 按该顺序截断，总长上限 SECTION_LIMIT。
   */
  private agentBody(agent: AgentProfile | undefined, repositoryId: string): string {
    if (!agent) return "";
    const parts: string[] = [];
    let budget = SECTION_LIMIT;
    for (const part of [agent.systemPrompt, agent.engineeringGuidelines ?? ""]) {
      if (!part) continue;
      if (budget <= 0) break;
      parts.push(part.length > budget ? part.slice(0, budget) : part);
      budget -= part.length;
    }
    const docs = (this.listWikiDocs?.(repositoryId) ?? []).filter((doc) => agent.wikiIncludePaths?.includes(doc.path));
    if (budget > 0 && docs.length > 0) {
      const wikiText = docs.map((doc) => `### 文档 ${doc.path}\n${doc.content}`).join("\n\n");
      parts.push(wikiText.length > budget ? wikiText.slice(0, budget) : wikiText);
    }
    return parts.join("\n\n");
  }

  /** 为每个关联仓库组装「Agent 指引」段；回退「通用」或内容为空时不输出该段。 */
  async resolveAgentContext(task: Task, repos: TaskRepository[]): Promise<AgentContext> {
    const sections: string[] = [];
    for (const repo of repos) {
      const agent = this.resolveAgentFor(repo.repositoryId, task.agentProfileId, task.repoAgentIds?.[repo.repositoryId]);
      const body = this.agentBody(agent, repo.repositoryId);
      if (!body) continue;
      const label = basename(repo.localPath.replace(/[\\/]+$/, "")) || repo.name;
      sections.push(`## Agent 指引 — 仓库 ${repo.name}（${label}）\n${body}`);
    }
    return { sections };
  }

  /**
   * 解析操作子 agent：按操作类型取对应内置角色 Agent，返回角色定义（systemPrompt）
   * 与领域指引（contextAgent 的 engineeringGuidelines + wiki 文档）。
   * 调用方决定是否组合两者（CodeReview 只取角色定义，不注入领域指引）。
   */
  resolveOperationAgent(operation: OperationKind, task?: Task, repos?: TaskRepository[]): { roleAgent: AgentProfile | undefined; roleBody: string; contextBody: string } {
    const roleId = ROLE_AGENT_DEFAULTS[operation].id;
    const roleAgent = this.list().find((a) => a.id === roleId && a.enabled);
    const roleBody = roleAgent?.systemPrompt ?? "";
    // 领域指引：contextAgent 的 engineeringGuidelines + wiki（非 CodeReview 时注入）
    let contextBody = "";
    if (task && repos && operation !== "review") {
      const parts: string[] = [];
      for (const repo of repos) {
        const contextAgent = this.resolveAgentFor(repo.repositoryId, task.agentProfileId, task.repoAgentIds?.[repo.repositoryId]);
        if (!contextAgent) continue;
        const body = this.agentBody(contextAgent, repo.repositoryId);
        if (body) {
          const label = basename(repo.localPath.replace(/[\\/]+$/, "")) || repo.name;
          parts.push(`## Agent 指引 — 仓库 ${repo.name}（${label}）\n${body}`);
        }
      }
      contextBody = parts.join("\n\n");
    }
    return { roleAgent, roleBody, contextBody };
  }
}

/** 新建 Agent 的草稿工厂（UI 使用）。 */
export function createAgentDraft(name: string, repositoryIds: string[] = []): AgentProfile {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name,
    systemPrompt: "",
    repositoryIds,
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
}
