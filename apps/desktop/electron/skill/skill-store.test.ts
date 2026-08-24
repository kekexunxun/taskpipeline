/**
 * skill-store 单测：frontmatter 解析、文件夹/zip 导入校验、zip slip 防护、删除与正文读取。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteSkill,
  importSkillFolder,
  importSkillZip,
  listSkills,
  parseSkillFrontmatter,
  readSkillContent,
  validateSkillMeta
} from './skill-store.js'

const VALID_SKILL = `---
name: 'demo-skill'
description: '测试技能。'
---

# Demo Skill
正文内容。
`

let root: string

beforeEach(() => {
  root = join(tmpdir(), `skill-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  execFileSync('rm', ['-rf', root])
})

/** 用系统 zip 打包 dir 到 zipPath。 */
function zipDir(zipPath: string, dir: string): void {
  execFileSync('zip', ['-q', '-r', '-y', zipPath, '.'], { cwd: dir })
}

function writeSkill(dir: string, name: string, content = VALID_SKILL): string {
  const target = join(dir, name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'SKILL.md'), content)
  return target
}

describe('parseSkillFrontmatter', () => {
  it('解析合法 frontmatter（name/description）', () => {
    const file = join(root, 'SKILL.md')
    writeFileSync(file, VALID_SKILL)
    expect(parseSkillFrontmatter(file)).toEqual({ name: 'demo-skill', description: '测试技能。' })
  })

  it('缺少 frontmatter 块报错', () => {
    const file = join(root, 'SKILL.md')
    writeFileSync(file, '# No Frontmatter\n')
    expect(parseSkillFrontmatter(file).error).toContain('frontmatter')
  })

  it('缺少 name/description 时返回空字段', () => {
    const file = join(root, 'SKILL.md')
    writeFileSync(file, '---\nfoo: bar\n---\nbody')
    const parsed = parseSkillFrontmatter(file)
    expect(parsed.name).toBeUndefined()
    expect(parsed.description).toBeUndefined()
  })
})

describe('validateSkillMeta', () => {
  it('name 仅允许小写字母/数字/连字符', () => {
    expect(validateSkillMeta('good-2', 'd')).toBeNull()
    expect(validateSkillMeta('Good Name', 'd')).toContain('仅允许')
    expect(validateSkillMeta('bad_Name', 'd')).toContain('仅允许')
  })

  it('description 必填', () => {
    expect(validateSkillMeta('ok', '')).toContain('description')
  })
})

describe('importSkillFolder', () => {
  it('导入合法文件夹，目录名以 frontmatter name 为准', () => {
    const folder = writeSkill(root, 'any-folder-name')
    const skill = importSkillFolder(join(root, 'skills'), folder)
    expect(skill).toMatchObject({ name: 'demo-skill', description: '测试技能。', source: 'folder' })
    expect(existsSync(join(root, 'skills', 'demo-skill', 'SKILL.md'))).toBe(true)
    expect(listSkills(join(root, 'skills'))).toHaveLength(1)
  })

  it('文件夹缺少 SKILL.md 报错', () => {
    const folder = join(root, 'empty')
    mkdirSync(folder, { recursive: true })
    expect(() => importSkillFolder(join(root, 'skills'), folder)).toThrow('SKILL.md')
  })

  it('frontmatter name 非法报错', () => {
    const folder = writeSkill(root, 'bad', VALID_SKILL.replace('demo-skill', 'Bad Name'))
    expect(() => importSkillFolder(join(root, 'skills'), folder)).toThrow('仅允许')
  })

  it('重名报错', () => {
    const folder = writeSkill(root, 'a')
    importSkillFolder(join(root, 'skills'), folder)
    expect(() => importSkillFolder(join(root, 'skills'), folder)).toThrow('已存在')
  })
})

describe('importSkillZip', () => {
  it('导入 zip（顶层目录含 SKILL.md）', async () => {
    const src = join(root, 'src')
    writeSkill(src, 'inner')
    const zipPath = join(root, 'skill.zip')
    zipDir(zipPath, src)
    const skill = await importSkillZip(join(root, 'skills'), zipPath)
    expect(skill).toMatchObject({ name: 'demo-skill', source: 'zip' })
    expect(existsSync(join(root, 'skills', 'demo-skill', 'SKILL.md'))).toBe(true)
  })

  it('导入 zip（根直接放 SKILL.md）', async () => {
    const src = join(root, 'flat')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), VALID_SKILL)
    const zipPath = join(root, 'flat.zip')
    zipDir(zipPath, src)
    const skill = await importSkillZip(join(root, 'skills'), zipPath)
    expect(skill.name).toBe('demo-skill')
  })

  it('zip 内无 SKILL.md 报错', async () => {
    const src = join(root, 'noskill')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'readme.txt'), 'no skill here')
    const zipPath = join(root, 'noskill.zip')
    zipDir(zipPath, src)
    await expect(importSkillZip(join(root, 'skills'), zipPath)).rejects.toThrow('SKILL.md')
  })

  it('zip slip（../ 越界条目）被 extract-zip 拦截', async () => {
    // 用 python3 构造恶意 zip（../evil.txt 指向解压目录外）。
    const evilZip = join(root, 'evil.zip')
    try {
      execFileSync('python3', [
        '-c',
        `
import zipfile
with zipfile.ZipFile(r'${evilZip}', 'w') as z:
    z.writestr('../evil.txt', 'pwned')
`
      ])
    } catch {
      return // 环境无 python3 则跳过
    }
    await expect(importSkillZip(join(root, 'skills'), evilZip)).rejects.toThrow()
    // 解压不应越界写出
    expect(existsSync(join(tmpdir(), 'evil.txt'))).toBe(false)
  }, 15_000)
})

describe('deleteSkill', () => {
  it('删除已导入技能', () => {
    const folder = writeSkill(root, 'a')
    importSkillFolder(join(root, 'skills'), folder)
    expect(() => deleteSkill(join(root, 'skills'), 'demo-skill')).not.toThrow()
    expect(listSkills(join(root, 'skills'))).toHaveLength(0)
  })

  it('路径穿越名被拒绝', () => {
    expect(() => deleteSkill(join(root, 'skills'), '../evil')).toThrow('不合法')
  })
})

describe('readSkillContent', () => {
  it('返回 <skill> 包装的正文（去掉 frontmatter）', () => {
    const folder = writeSkill(root, 'a')
    importSkillFolder(join(root, 'skills'), folder)
    const content = readSkillContent(join(root, 'skills'), 'demo-skill')
    expect(content).toContain('<skill name="demo-skill">')
    expect(content).toContain('<description>测试技能。</description>')
    expect(content).toContain('# Demo Skill')
    expect(content).not.toContain("name: 'demo-skill'")
  })

  it('不存在的技能返回 undefined', () => {
    expect(readSkillContent(join(root, 'skills'), 'nope')).toBeUndefined()
  })

  it('非法 name 返回 undefined', () => {
    expect(readSkillContent(join(root, 'skills'), '../evil')).toBeUndefined()
  })
})
