/**
 * Skill 管理（dataDir/skills）—— Agent Skills 标准（目录含 SKILL.md，frontmatter name/description）。
 *
 * 与 qodercli 实测结论对齐（docs/mcp-skill-settings-plan.md §4.2）：
 *  - 技能文件 = <root>/<name>/SKILL.md，Qoder 对话通过 `Options.skills: [name]` +
 *    `env.QODER_CONFIG_DIR = dataDir` 让 CLI 从 dataDir/skills 发现并注入；
 *  - OpenAI 对话把选中技能正文拼进 system（openai-chat-driver 负责读取）；
 *  - pi 任务板块注入暂缓（后续拓展，见计划 §4.3）。
 *
 * zip 导入用 extract-zip（内部按 yauzl validateFileName 校验，防 zip slip 路径穿越）；
 * 目录名以 SKILL.md frontmatter 的 name 为准（校验 ^[a-z0-9-]+$，description 必填）。
 */

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import extract from 'extract-zip'

export type SkillInfo = {
  name: string
  description: string
  /** skill 目录（<root>/<name>）。 */
  path: string
  source: 'folder' | 'zip'
}

export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/

/** 解析 SKILL.md frontmatter（--- 包裹，name/description 简单 key: value）。 */
export function parseSkillFrontmatter(skillMdPath: string): { name?: string; description?: string; error?: string } {
  let raw: string
  try {
    raw = readFileSync(skillMdPath, 'utf8')
  } catch (reason) {
    return { error: `无法读取 SKILL.md：${reason instanceof Error ? reason.message : String(reason)}` }
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return { error: '缺少 frontmatter（文件开头需有 --- 包裹的 YAML）' }
  const body = match[1] ?? ''
  const name = body.match(/^name\s*:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]?.trim()
  const description = body.match(/^description\s*:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]?.trim()
  return { name, description }
}

/** 校验 frontmatter：name 合法 + description 必填。 */
export function validateSkillMeta(name: string | undefined, description: string | undefined): string | null {
  if (!name) return 'SKILL.md 缺少 name'
  if (!SKILL_NAME_PATTERN.test(name)) return 'SKILL.md 的 name 仅允许小写字母、数字、连字符'
  if (!description) return 'SKILL.md 缺少 description'
  return null
}

function findSkillDir(root: string, depth: number): string | undefined {
  if (depth <= 0 || !existsSync(root)) return undefined
  const entries = readdirSync(root, { withFileTypes: true })
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) return root
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const found = findSkillDir(join(root, entry.name), depth - 1)
    if (found) return found
  }
  return undefined
}

/** 校验目标目录名安全（防路径穿越）：必须落在 rootDir 内。 */
function assertSafeName(rootDir: string, name: string): string {
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error('技能名不合法（仅允许小写字母、数字、连字符）')
  const target = resolve(rootDir, name)
  const root = resolve(rootDir)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('非法技能路径')
  return target
}

export function listSkills(rootDir: string): SkillInfo[] {
  if (!existsSync(rootDir)) return []
  const out: SkillInfo[] = []
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillDir = join(rootDir, entry.name)
    const skillMd = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMd)) continue
    const { name, description, error } = parseSkillFrontmatter(skillMd)
    if (error || !name || !description || validateSkillMeta(name, description)) continue
    out.push({ name, description, path: skillDir, source: 'folder' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 从已解压目录（或本地文件夹）导入技能：以 frontmatter name 为目标目录名拷贝。 */
function importSkillFromDir(rootDir: string, extractedRoot: string, source: 'folder' | 'zip'): SkillInfo {
  const skillDir = findSkillDir(extractedRoot, 3)
  if (!skillDir) throw new Error('未在导入内容中找到 SKILL.md')
  const { name, description, error } = parseSkillFrontmatter(join(skillDir, 'SKILL.md'))
  if (error) throw new Error(error)
  const metaError = validateSkillMeta(name, description)
  if (metaError) throw new Error(metaError)
  const target = assertSafeName(rootDir, name!)
  if (existsSync(target)) throw new Error(`同名技能「${name}」已存在，请先删除再导入`)
  mkdirSync(rootDir, { recursive: true })
  cpSync(skillDir, target, { recursive: true })
  return { name: name!, description: description!, path: target, source }
}

/** 导入 zip（本地路径；extract-zip 内部防 zip slip）。 */
export async function importSkillZip(rootDir: string, zipPath: string): Promise<SkillInfo> {
  if (!existsSync(zipPath)) throw new Error('zip 文件不存在')
  const tmp = mkdtempSync(join(tmpdir(), 'taskpipeline-skill-'))
  try {
    await extract(zipPath, { dir: tmp })
    return importSkillFromDir(rootDir, tmp, 'zip')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** 从本地文件夹导入（要求目录含 SKILL.md）。 */
export function importSkillFolder(rootDir: string, folderPath: string): SkillInfo {
  if (!existsSync(join(folderPath, 'SKILL.md'))) throw new Error('所选文件夹中未找到 SKILL.md')
  return importSkillFromDir(rootDir, folderPath, 'folder')
}

/** 删除技能（name 需通过安全校验）。 */
export function deleteSkill(rootDir: string, name: string): void {
  const target = assertSafeName(rootDir, name)
  if (!existsSync(target)) throw new Error(`技能「${name}」不存在`)
  rmSync(target, { recursive: true, force: true })
}

/** 读取技能正文（OpenAI 对话注入用）；拼接目录下其余 .md 为补充上下文。 */
export function readSkillContent(rootDir: string, name: string): string | undefined {
  if (!SKILL_NAME_PATTERN.test(name)) return undefined
  const skillMd = join(rootDir, name, 'SKILL.md')
  if (!existsSync(skillMd)) return undefined
  const meta = parseSkillFrontmatter(skillMd)
  let body = readFileSync(skillMd, 'utf8')
  // 去掉 frontmatter 块，保留正文
  body = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const header = [`<skill name="${name}">`]
  if (meta.description) header.push(`<description>${meta.description}</description>`)
  return `${header.join('\n')}\n${body.trim()}\n</skill>`
}
