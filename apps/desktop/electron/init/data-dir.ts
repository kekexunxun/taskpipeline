import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { TaskStore, LocalFileKeyStore, type Task } from '@task-pipeline/core'
import { finalizeTaskTrace } from '../task/task-lifecycle.js'

/**
 * 解析自定义数据目录路径。
 * 优先级：环境变量 > 配置文件 > 默认 userData/data。
 */
export function resolveDataDir(): string {
  const dataDirConfigPath = join(app.getPath('userData'), 'data-dir.json')
  const dataDir =
    process.env.TASK_PIPELINE_DATA_DIR ?? readCustomDataDir(dataDirConfigPath) ?? join(app.getPath('userData'), 'data')
  process.env.TASK_PIPELINE_DATA_DIR = dataDir
  mkdirSync(dataDir, { recursive: true })
  return dataDir
}

/** 从配置文件读取用户自定义的数据目录路径。 */
function readCustomDataDir(configPath: string): string | undefined {
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (typeof parsed.path === 'string' && parsed.path.length > 0) return parsed.path
    }
  } catch {
    /* 配置文件损坏时回退默认 */
  }
  return undefined
}

/** 将用户选择的数据目录路径持久化到配置文件。 */
export function writeCustomDataDir(dir: string): void {
  const configPath = join(app.getPath('userData'), 'data-dir.json')
  writeFileSync(configPath, JSON.stringify({ path: dir }, null, 2), 'utf-8')
}

/** 创建应用核心 Store 实例（TaskStore + LocalFileKeyStore）。 */
export function createAppStores(dataDir: string): {
  store: InstanceType<typeof TaskStore>
  keyStore: InstanceType<typeof LocalFileKeyStore>
} {
  const store = new (class extends TaskStore {
    override updateTask(id: string, patch: Parameters<TaskStore['updateTask']>[1]): Task {
      const updated = super.updateTask(id, patch)
      if (updated.state === 'completed' || updated.state === 'failed' || updated.state === 'cancelled') {
        finalizeTaskTrace(id)
      }
      return updated
    }
    override deleteTask(id: string): void {
      finalizeTaskTrace(id)
      super.deleteTask(id)
    }
  })(join(dataDir, 'task-pipeline.db'))
  const keyStore = new LocalFileKeyStore(dataDir)
  return { store, keyStore }
}
