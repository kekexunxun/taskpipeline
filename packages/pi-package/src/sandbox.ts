import { relative, resolve } from 'node:path'
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ExtensionAPI,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations
} from '@earendil-works/pi-coding-agent'
import type { Task, TaskStore } from '@task-pipeline/core'
import { DockerSandbox } from '@task-pipeline/integrations'

type SandboxMode = 'checking' | 'docker' | 'host'

export class DockerToolRouter {
  private readonly docker: DockerSandbox
  private mode: SandboxMode = 'checking'
  private containerName?: string
  private mountSignature?: string
  private startPromise?: Promise<string | undefined>

  constructor(
    private readonly store: TaskStore,
    private readonly getTask: () => Task | undefined,
    dockerCommand = 'docker'
  ) {
    this.docker = new DockerSandbox(dockerCommand)
  }

  activeCwd(fallback: string): string {
    const task = this.getTask()
    return task
      ? (this.store.listTaskRepositories(task.id)[0]?.worktreePath ??
          this.store.listTaskRepositories(task.id)[0]?.localPath ??
          fallback)
      : fallback
  }

  async check(): Promise<SandboxMode> {
    if (this.mode !== 'checking') return this.mode
    this.mode = (await this.docker.available()) ? 'docker' : 'host'
    return this.mode
  }

  /**
   * Docker 沙箱不可用（docker 存在但镜像拉取/容器启动/命令执行失败）时降级为本机执行。
   * 降级是持久的（本次进程内不再重试 docker），并写一条任务状态事件告知用户。
   */
  private degrade(reason: string): void {
    this.mode = 'host'
    this.containerName = undefined
    console.warn(`[sandbox] Docker 沙箱不可用，回退到本机执行：${reason}`)
    const task = this.getTask()
    if (task)
      this.store.addEvent({
        taskId: task.id,
        kind: 'status',
        title: '执行环境：回退本机',
        detail: `Docker 沙箱启动失败（${reason}），已自动回退到本机直接执行`
      })
  }

  async container(): Promise<string | undefined> {
    if ((await this.check()) !== 'docker') return undefined
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startContainer()
      .catch((error) => {
        this.degrade(error instanceof Error ? error.message : String(error))
        return undefined
      })
      .finally(() => {
        this.startPromise = undefined
      })
    return this.startPromise
  }

  private async startContainer(): Promise<string | undefined> {
    const task = this.getTask()
    if (!task) return undefined
    const worktrees = this.store
      .listTaskRepositories(task.id)
      .map((repo) => repo.worktreePath ?? repo.localPath)
      .filter(Boolean)
    if (worktrees.length === 0) return undefined
    const name = `task-pipeline-${task.id
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 20)
      .toLowerCase()}`
    const signature = worktrees.slice().sort().join('\n')
    if (this.containerName === name && this.mountSignature === signature) return name
    if (this.containerName) await this.docker.stop(this.containerName)
    await this.docker.start({
      image: this.store.getSetting('sandboxImage') ?? 'task-pipeline:dev',
      name,
      worktrees,
      network: (this.store.getSetting('sandboxNetwork') as 'default' | 'none' | undefined) ?? 'default'
    })
    this.containerName = name
    this.mountSignature = signature
    return name
  }

  async stop(): Promise<void> {
    if (this.containerName) await this.docker.stop(this.containerName)
    this.containerName = undefined
    this.mountSignature = undefined
  }

  async run(
    cwd: string,
    file: string,
    args: string[] = []
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const name = await this.container()
    if (!name) throw new Error('Docker sandbox is unavailable')
    const result = await this.docker.execAt(name, cwd, file, args)
    return { stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'), exitCode: result.exitCode }
  }

  private async readOperations(): Promise<ReadOperations | undefined> {
    const name = await this.container()
    if (!name) return undefined
    return {
      readFile: (path) => this.docker.exec(name, ['cat', '--', path]),
      access: async (path) => {
        await this.docker.exec(name, ['test', '-r', path])
      },
      detectImageMimeType: async () => null
    }
  }

  private async writeOperations(): Promise<WriteOperations | undefined> {
    const name = await this.container()
    if (!name) return undefined
    return {
      writeFile: async (path, content) => {
        await this.docker.exec(name, ['sh', '-c', 'mkdir -p "$(dirname "$1")"; cat > "$1"', 'sh', path], content)
      },
      mkdir: async (path) => {
        await this.docker.exec(name, ['mkdir', '-p', '--', path])
      }
    }
  }

  private async editOperations(): Promise<EditOperations | undefined> {
    const read = await this.readOperations()
    const write = await this.writeOperations()
    if (!read || !write) return undefined
    return { readFile: read.readFile, writeFile: write.writeFile, access: read.access }
  }

  private async bashOperations(): Promise<BashOperations | undefined> {
    const name = await this.container()
    if (!name) return undefined
    return { exec: (command, cwd, options) => this.docker.execStreaming(name, cwd, command, options) }
  }

  private async lsOperations(): Promise<LsOperations | undefined> {
    const name = await this.container()
    if (!name) return undefined
    return {
      exists: async (path) => (await this.docker.execResult(name, ['test', '-e', path])).exitCode === 0,
      stat: async (path) => ({
        isDirectory: () => false,
        ...((await this.docker.execResult(name, ['test', '-d', path])).exitCode === 0
          ? { isDirectory: () => true }
          : {})
      }),
      readdir: async (path) =>
        (await this.docker.exec(name, ['find', path, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\n']))
          .toString('utf8')
          .split(/\r?\n/)
          .filter(Boolean)
    }
  }

  private async findOperations(): Promise<FindOperations | undefined> {
    const name = await this.container()
    if (!name) return undefined
    return {
      exists: async (path) => (await this.docker.execResult(name, ['test', '-e', path])).exitCode === 0,
      glob: async (pattern, cwd, options) => {
        const script = pattern.includes('/')
          ? 'find "$1" -type f ! -path "*/node_modules/*" ! -path "*/.git/*" -path "$1/$2" -print | head -n "$3"'
          : 'find "$1" -type f ! -path "*/node_modules/*" ! -path "*/.git/*" -name "$2" -print | head -n "$3"'
        return (await this.docker.exec(name, ['sh', '-c', script, 'sh', cwd, pattern, String(options.limit)]))
          .toString('utf8')
          .split(/\r?\n/)
          .filter(Boolean)
      }
    }
  }

  register(pi: ExtensionAPI, initialCwd: string): void {
    const localRead = createReadTool(initialCwd)
    const localWrite = createWriteTool(initialCwd)
    const localEdit = createEditTool(initialCwd)
    const localBash = createBashTool(initialCwd)
    const localLs = createLsTool(initialCwd)
    const localFind = createFindTool(initialCwd)
    const localGrep = createGrepTool(initialCwd)

    pi.registerTool({
      ...localRead,
      execute: async (id, params, signal, update) => {
        const cwd = this.activeCwd(initialCwd)
        const ops = (await this.check()) === 'docker' ? await this.readOperations() : undefined
        const tool = ops ? createReadTool(cwd, { operations: ops }) : createReadTool(cwd)
        return tool.execute(id, params, signal, update)
      }
    })
    pi.registerTool({
      ...localWrite,
      execute: async (id, params, signal, update) => {
        const cwd = this.activeCwd(initialCwd)
        const ops = (await this.check()) === 'docker' ? await this.writeOperations() : undefined
        const tool = ops ? createWriteTool(cwd, { operations: ops }) : createWriteTool(cwd)
        return tool.execute(id, params, signal, update)
      }
    })
    pi.registerTool({
      ...localEdit,
      execute: async (id, params, signal, update) => {
        const cwd = this.activeCwd(initialCwd)
        const ops = (await this.check()) === 'docker' ? await this.editOperations() : undefined
        const tool = ops ? createEditTool(cwd, { operations: ops }) : createEditTool(cwd)
        return tool.execute(id, params, signal, update)
      }
    })
    pi.registerTool({
      ...localBash,
      execute: async (id, params, signal, update) => {
        const cwd = this.activeCwd(initialCwd)
        const ops = (await this.check()) === 'docker' ? await this.bashOperations() : undefined
        const tool = ops ? createBashTool(cwd, { operations: ops }) : createBashTool(cwd)
        return tool.execute(id, params, signal, update)
      }
    })
    pi.registerTool({
      ...localLs,
      execute: async (id, params, signal, update) => {
        const cwd = this.activeCwd(initialCwd)
        const ops = (await this.check()) === 'docker' ? await this.lsOperations() : undefined
        const tool = ops ? createLsTool(cwd, { operations: ops }) : createLsTool(cwd)
        return tool.execute(id, params, signal, update)
      }
    })
    pi.registerTool({
      ...localFind,
      execute: async (id, params, signal, update) => {
        const cwd = this.activeCwd(initialCwd)
        const ops = (await this.check()) === 'docker' ? await this.findOperations() : undefined
        const tool = ops ? createFindTool(cwd, { operations: ops }) : createFindTool(cwd)
        return tool.execute(id, params, signal, update)
      }
    })
    pi.registerTool({
      ...localGrep,
      execute: async (id, params, signal, update) => {
        const cwd = this.activeCwd(initialCwd)
        if ((await this.check()) !== 'docker') return createGrepTool(cwd).execute(id, params, signal, update)
        const name = await this.container()
        if (!name) return createGrepTool(cwd).execute(id, params, signal, update)
        const path = resolve(cwd, params.path ?? '.')
        const args = [
          'rg',
          '--line-number',
          '--color=never',
          '--hidden',
          ...(params.ignoreCase ? ['--ignore-case'] : []),
          ...(params.literal ? ['--fixed-strings'] : []),
          ...(params.glob ? ['--glob', params.glob] : []),
          ...(params.context ? ['--context', String(params.context)] : []),
          '--',
          params.pattern,
          path
        ]
        const result = await this.docker.execResult(name, args)
        if (result.exitCode > 1)
          throw new Error(result.stderr.toString('utf8') || `ripgrep exited with ${result.exitCode}`)
        const lines = result.stdout
          .toString('utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(0, params.limit ?? 100)
          .map((line) => line.replace(path, relative(cwd, path) || '.'))
        return {
          content: [{ type: 'text', text: lines.join('\n') || 'No matches found' }],
          details: lines.length >= (params.limit ?? 100) ? { matchLimitReached: params.limit ?? 100 } : undefined
        }
      }
    })

    pi.on('user_bash', async () => {
      if ((await this.check()) !== 'docker') return undefined
      const operations = await this.bashOperations()
      return operations ? { operations } : undefined
    })
  }
}
