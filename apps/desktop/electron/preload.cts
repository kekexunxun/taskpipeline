import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('agentApi', {
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  getTask: (id: string) => ipcRenderer.invoke('tasks:get', id),
  createTask: (input: unknown) => ipcRenderer.invoke('tasks:create', input),
  updateTask: (id: string, patch: unknown) => ipcRenderer.invoke('tasks:update', id, patch),
  deleteTask: (id: string, mode?: 'workspace' | 'all') => ipcRenderer.invoke('tasks:delete', id, mode),
  listRepositories: () => ipcRenderer.invoke('repos:list'),
  saveRepository: (profile: unknown) => ipcRenderer.invoke('repos:save', profile),
  deleteRepository: (id: string) => ipcRenderer.invoke('repos:delete', id),
  chooseRepositoryFolder: () => ipcRenderer.invoke('repos:choose-folder'),
  attachRepository: (taskId: string, repositoryId: string) =>
    ipcRenderer.invoke('tasks:attach-repo', taskId, repositoryId),
  detachRepository: (taskId: string, repositoryId: string) =>
    ipcRenderer.invoke('tasks:detach-repo', taskId, repositoryId),
  updateTaskRepositoryCommands: (taskId: string, repositoryId: string, commands: unknown) =>
    ipcRenderer.invoke('tasks:update-repo-commands', taskId, repositoryId, commands),
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string, secret?: boolean) => ipcRenderer.invoke('settings:set', key, value, secret),
  startTask: (taskId: string, options?: unknown) => ipcRenderer.invoke('tasks:start', taskId, options),
  reimplementTask: (taskId: string) => ipcRenderer.invoke('tasks:reimplement', taskId),
  resumeTask: (taskId: string) => ipcRenderer.invoke('tasks:resume', taskId),
  pauseTask: (taskId: string) => ipcRenderer.invoke('tasks:pause', taskId),
  resumePausedTask: (taskId: string) => ipcRenderer.invoke('tasks:resume-paused', taskId),
  updateTaskPlan: (taskId: string, planContent: string) => ipcRenderer.invoke('tasks:update-plan', taskId, planContent),
  approveTaskPlan: (taskId: string) => ipcRenderer.invoke('tasks:approve-plan', taskId),
  reviseTaskPlan: (taskId: string, feedback: string) => ipcRenderer.invoke('tasks:revise-plan', taskId, feedback),
  retryTaskValidation: (taskId: string) => ipcRenderer.invoke('tasks:retry-validation', taskId),
  sendTaskMessage: (taskId: string, message: string) => ipcRenderer.invoke('tasks:message', taskId, message),
  abortTask: () => ipcRenderer.invoke('tasks:abort'),
  cancelTask: (taskId: string) => ipcRenderer.invoke('tasks:cancel', taskId),
  runReview: (taskId: string) => ipcRenderer.invoke('tasks:review', taskId),
  resetReview: (taskId: string) => ipcRenderer.invoke('tasks:reset-review', taskId),
  resetDelivery: (taskId: string) => ipcRenderer.invoke('tasks:reset-delivery', taskId),
  submitMergeRequests: (taskId: string) => ipcRenderer.invoke('tasks:submit-mrs', taskId),
  refreshMergeStatus: () => ipcRenderer.invoke('tasks:refresh-merge-status'),
  manualComplete: (taskId: string) => ipcRenderer.invoke('tasks:manual-complete', taskId),
  importJiraTask: (keyOrUrl: string) => ipcRenderer.invoke('jira:import', keyOrUrl),
  syncJiraTasks: () => ipcRenderer.invoke('jira:sync'),
  importJiraTasks: (candidates: unknown[]) => ipcRenderer.invoke('jira:import-many', candidates),
  testAtlassian: (kind: 'jira' | 'confluence') => ipcRenderer.invoke('atlassian:test', kind),
  testGitlabMcp: () => ipcRenderer.invoke('gitlab:test-mcp'),
  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  saveMcpServer: (entry: unknown) => ipcRenderer.invoke('mcp:save', entry),
  deleteMcpServer: (id: string) => ipcRenderer.invoke('mcp:delete', id),
  testMcpServer: (id: string) => ipcRenderer.invoke('mcp:test', id),
  listSkills: () => ipcRenderer.invoke('skill:list'),
  importSkillZip: () => ipcRenderer.invoke('skill:import-zip'),
  importSkillFolder: () => ipcRenderer.invoke('skill:import-folder'),
  deleteSkill: (name: string) => ipcRenderer.invoke('skill:delete', name),
  checkCredentials: () => ipcRenderer.invoke('settings:check-credentials'),
  getCredentialState: () => ipcRenderer.invoke('credentials:state'),
  onCredentialStateChange: (callback: (states: unknown) => void) => {
    const listener = (_: unknown, states: unknown) => callback(states)
    ipcRenderer.on('credentials:state-changed', listener)
    return () => ipcRenderer.removeListener('credentials:state-changed', listener)
  },
  openTaskEditor: (taskId: string, editor: 'vscode' | 'qoder') =>
    ipcRenderer.invoke('tasks:open-editor', taskId, editor),
  mergeBackToBase: (taskId: string) => ipcRenderer.invoke('tasks:merge-back-to-base', taskId),
  revealTaskWorkspace: (taskId: string) => ipcRenderer.invoke('tasks:reveal-workspace', taskId),
  listTaskBackends: () => ipcRenderer.invoke('tasks:list-backends'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  getQoderStatus: () => ipcRenderer.invoke('qoder:status'),
  respondTaskUi: (response: unknown) => ipcRenderer.invoke('task:ui-response', response),
  onTaskEvent: (callback: (event: unknown) => void) => {
    const listener = (_: unknown, event: unknown) => callback(event)
    ipcRenderer.on('task:event', listener)
    return () => ipcRenderer.removeListener('task:event', listener)
  },
  // === Memory 系统(仓库级 / 用户级 / 对话级 + repowiki 文档) ==================
  listMemories: (filter?: unknown) => ipcRenderer.invoke('memory:list', filter),
  upsertMemory: (input: unknown) => ipcRenderer.invoke('memory:upsert', input),
  updateMemory: (id: string, patch: unknown) => ipcRenderer.invoke('memory:update', id, patch),
  deleteMemory: (id: string) => ipcRenderer.invoke('memory:delete', id),
  searchMemory: (query: string, options?: unknown) => ipcRenderer.invoke('memory:search', query, options),
  indexRepoWiki: (repositoryId: string) => ipcRenderer.invoke('repowiki:index', repositoryId),
  listRepoWikiDocs: (repositoryId: string) => ipcRenderer.invoke('repowiki:list', repositoryId),
  searchRepoWiki: (repositoryId: string, query: string) => ipcRenderer.invoke('repowiki:search', repositoryId, query),
  // === Agent 配置 ==================================================
  listAgents: () => ipcRenderer.invoke('agents:list'),
  saveAgent: (profile: unknown) => ipcRenderer.invoke('agents:save', profile),
  deleteAgent: (id: string) => ipcRenderer.invoke('agents:delete', id),
  listAgentTemplates: () => ipcRenderer.invoke('agents:templates'),
  exportAgents: () => ipcRenderer.invoke('agents:export'),
  importAgents: () => ipcRenderer.invoke('agents:import'),
  generateAgentContent: (input: unknown) => ipcRenderer.invoke('agents:generate-content', input),
  // === Chat 对话(Codex 样式) ==================================================
  listChats: () => ipcRenderer.invoke('chats:list'),
  listChatGroups: () => ipcRenderer.invoke('chats:list-groups'),
  getChat: (id: string) => ipcRenderer.invoke('chats:get', id),
  createChat: (model?: string) => ipcRenderer.invoke('chats:create', model),
  deleteChat: (id: string) => ipcRenderer.invoke('chats:delete', id),
  setChatDirectory: (id: string, workingDirectory?: string) =>
    ipcRenderer.invoke('chats:set-directory', id, workingDirectory),
  listChatModels: () => ipcRenderer.invoke('chats:list-models'),
  getDefaultModel: () => ipcRenderer.invoke('chats:default-model'),
  startChatStream: (input: unknown) => ipcRenderer.invoke('chats:start-stream', input),
  abortChat: (input: unknown) => ipcRenderer.invoke('chats:abort', input),
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
  chooseDirectories: () => ipcRenderer.invoke('dialog:choose-directories'),
  // === Chat 分组(工作区 CRUD) ==================================================
  createChatWorkspace: (name: string, directories: string[]) =>
    ipcRenderer.invoke('chat-groups:create-workspace', name, directories),
  deleteChatGroup: (id: string) => ipcRenderer.invoke('chat-groups:delete', id),
  onChatStreamEvent: (callback: (event: unknown) => void) => {
    const listener = (_: unknown, event: unknown) => callback(event)
    ipcRenderer.on('chat:stream-event', listener)
    return () => ipcRenderer.removeListener('chat:stream-event', listener)
  },
  // === Trace 页面(v2：AgentSpan 管道) ===========================================
  listTrace: () => ipcRenderer.invoke('trace:list'),
  getTrace: (kind: string, traceId: string) => ipcRenderer.invoke('trace:get', kind, traceId),
  dashboardTrace: () => ipcRenderer.invoke('trace:dashboard'),
  deleteTrace: (kind: string, traceId: string) => ipcRenderer.invoke('trace:delete', kind, traceId),
  // === HITL 模式切换（支持按对话/任务上下文区分） ===========================================================
  setHitlMode: (mode: 'ask' | 'auto' | 'yolo', contextType?: 'conversation' | 'task', contextId?: string) =>
    ipcRenderer.invoke('hitl:set-mode', mode, contextType, contextId),
  getHitlMode: (contextType?: 'conversation' | 'task', contextId?: string) =>
    ipcRenderer.invoke('hitl:get-mode', contextType, contextId),
  // === 自动更新 ============================================================
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdateStatus: () => ipcRenderer.invoke('updater:status'),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const listener = (_: unknown, status: unknown) => callback(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  }
})
