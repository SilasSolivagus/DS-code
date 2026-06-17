import { describe, it, expect } from 'vitest'
import { parseSkillFile, loadSkills, substituteSkillArgs } from '../src/skillsLoader.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('parseSkillFile', () => {
  it('解析 frontmatter 全字段', () => {
    const raw = `---
name: review-pr
description: 审查 PR
when-to-use: 用户要审查代码改动时
context: fork
agent: general-purpose
allowed-tools: Read, Grep
arguments: target
disable-model-invocation: false
---
请审查 $ARG1 的改动。`
    const s = parseSkillFile(raw, '/skills/review-pr', 'review-pr')!
    expect(s.name).toBe('review-pr')
    expect(s.description).toBe('审查 PR')
    expect(s.whenToUse).toBe('用户要审查代码改动时')
    expect(s.context).toBe('fork')
    expect(s.agent).toBe('general-purpose')
    expect(s.allowedTools).toEqual(['Read', 'Grep'])
    expect(s.argNames).toEqual(['target'])
    expect(s.userInvocable).toBe(true)
    expect(s.modelInvocable).toBe(true)
    expect(s.isLegacy).toBe(false)
    expect(s.body).toBe('请审查 $ARG1 的改动。')
  })

  it('默认值：无 frontmatter context→inline，可见性双开，name 取 fallback，description 取正文首非空行', () => {
    const s = parseSkillFile('\n做一件事\n更多内容', '/skills/x', 'do-thing')!
    expect(s.name).toBe('do-thing')
    expect(s.description).toBe('做一件事')
    expect(s.context).toBe('inline')
    expect(s.userInvocable).toBe(true)
    expect(s.modelInvocable).toBe(true)
  })

  it('可见性字段：user-invocable:false 关用户路径；disable-model-invocation:true 关模型路径', () => {
    const raw = `---
description: x
user-invocable: false
disable-model-invocation: true
---
body`
    const s = parseSkillFile(raw, '/d', 'x')!
    expect(s.userInvocable).toBe(false)
    expect(s.modelInvocable).toBe(false)
  })

  it('legacy 命令：isLegacy=true → user-only, inline, body=全文', () => {
    const s = parseSkillFile('回顾 $ARGUMENTS', '/cmds', 'recap', true)!
    expect(s.isLegacy).toBe(true)
    expect(s.userInvocable).toBe(true)
    expect(s.modelInvocable).toBe(false)
    expect(s.context).toBe('inline')
    expect(s.body).toBe('回顾 $ARGUMENTS')
  })

  it('正文为空 → null（无内容的 skill 无意义）', () => {
    expect(parseSkillFile('---\ndescription: x\n---\n', '/d', 'x')).toBeNull()
  })
})

describe('loadSkills 发现 + 合并', () => {
  it('扫 skills 目录 + legacy commands；同名 skill 覆盖 legacy；缺目录跳过', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-home-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cwd-'))
    // 一个项目级 skill 目录
    fs.mkdirSync(path.join(cwd, '.deepcode', 'skills', 'greet'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.deepcode', 'skills', 'greet', 'SKILL.md'), '---\ndescription: 打招呼\n---\n说你好')
    // 一个 legacy 命令同名 greet（应被 skill 覆盖）+ 一个独有 legacy recap
    fs.mkdirSync(path.join(cwd, '.deepcode', 'commands'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.deepcode', 'commands', 'greet.md'), '旧打招呼')
    fs.writeFileSync(path.join(cwd, '.deepcode', 'commands', 'recap.md'), '回顾 $ARGUMENTS')

    const skills = loadSkills(cwd, home)
    const byName = Object.fromEntries(skills.map(s => [s.name, s]))
    expect(byName['greet'].isLegacy).toBe(false)     // skill 覆盖了 legacy
    expect(byName['greet'].body).toBe('说你好')
    expect(byName['recap'].isLegacy).toBe(true)      // 独有 legacy 保留
  })
})

describe('loadSkills config（sources/deny/priority）', () => {
  function setup() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-home-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cwd-'))
    // home/.claude/skills/cso（模拟 gstack 灌入）
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'cso'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'cso', 'SKILL.md'), '---\ndescription: 安全审计\n---\n审计')
    // home/.deepcode/skills/hello（user 级 deepcode 源）
    fs.mkdirSync(path.join(home, '.deepcode', 'skills', 'hello'), { recursive: true })
    fs.writeFileSync(path.join(home, '.deepcode', 'skills', 'hello', 'SKILL.md'), '---\ndescription: 问好\n---\n你好')
    // cwd/.deepcode/skills/proj（项目级）
    fs.mkdirSync(path.join(cwd, '.deepcode', 'skills', 'proj'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.deepcode', 'skills', 'proj', 'SKILL.md'), '---\ndescription: 项目技能\n---\n做事')
    // cwd/.deepcode/commands/recap.md（legacy）
    fs.mkdirSync(path.join(cwd, '.deepcode', 'commands'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.deepcode', 'commands', 'recap.md'), '回顾')
    return { home, cwd }
  }

  it('sources:["deepcode"] 跳过 .claude 源（干掉 cso 灌入）', () => {
    const { home, cwd } = setup()
    const names = loadSkills(cwd, home, { sources: ['deepcode'] }).map(s => s.name)
    expect(names).not.toContain('cso')
    expect(names).toEqual(expect.arrayContaining(['hello', 'proj', 'recap']))
  })

  it('deny 精确排除', () => {
    const { home, cwd } = setup()
    const names = loadSkills(cwd, home, { deny: ['cso', 'recap'] }).map(s => s.name)
    expect(names).not.toContain('cso')
    expect(names).not.toContain('recap')
    expect(names).toEqual(expect.arrayContaining(['hello', 'proj']))
  })

  it('priority 赋值：项目 0 / user(home) 1 / legacy 2', () => {
    const { home, cwd } = setup()
    const byName = Object.fromEntries(loadSkills(cwd, home).map(s => [s.name, s.priority]))
    expect(byName['proj']).toBe(0)   // 项目 skills
    expect(byName['hello']).toBe(1)  // home/.deepcode/skills
    expect(byName['cso']).toBe(1)    // home/.claude/skills
    expect(byName['recap']).toBe(2)  // legacy commands
  })

  it('无 config：发现/合并语义同现状（仅多了 priority 字段）', () => {
    const { home, cwd } = setup()
    const names = loadSkills(cwd, home).map(s => s.name).sort()
    expect(names).toEqual(['cso', 'hello', 'proj', 'recap'])
  })
})

describe('substituteSkillArgs', () => {
  it('$ARGUMENTS 全文替换（legacy 向后兼容）', () => {
    expect(substituteSkillArgs('回顾 $ARGUMENTS', 'a b c', { skillDir: '/d' })).toBe('回顾 a b c')
  })
  it('$ARG1/$ARG2 按空白切分', () => {
    expect(substituteSkillArgs('$ARG1 then $ARG2', 'foo bar', { skillDir: '/d' })).toBe('foo then bar')
  })
  it('${DEEPCODE_SKILL_DIR} / ${DEEPCODE_SESSION_ID}', () => {
    expect(substituteSkillArgs('dir=${DEEPCODE_SKILL_DIR} sid=${DEEPCODE_SESSION_ID}', '', { skillDir: '/skills/x', sessionId: 'sess1' }))
      .toBe('dir=/skills/x sid=sess1')
  })
  it('缺参数的 $ARGn 替换成空串；无 sessionId → 空串', () => {
    expect(substituteSkillArgs('[$ARG1][$ARG2]', 'only', { skillDir: '/d' })).toBe('[only][]')
    expect(substituteSkillArgs('${DEEPCODE_SESSION_ID}', '', { skillDir: '/d' })).toBe('')
  })
})

describe('substituteSkillArgs — 命名参数', () => {
  it('argNames 有值时按名替换（spec §3.4）', () => {
    // argNames[0]='target', argNames[1]='branch' → $target 对应 parts[0], $branch 对应 parts[1]
    expect(substituteSkillArgs(
      '审查 $target 的 $branch 分支',
      'main feat/foo',
      { skillDir: '/d', argNames: ['target', 'branch'] },
    )).toBe('审查 main 的 feat/foo 分支')
  })

  it('缺参数时替换为空串', () => {
    expect(substituteSkillArgs(
      '[$target][$branch]',
      'only-target',
      { skillDir: '/d', argNames: ['target', 'branch'] },
    )).toBe('[only-target][]')
  })

  it('不吃前缀：$foo 不替换 $foobar 的前缀部分', () => {
    // 正文有 $foobar 和 $foo，argNames=['foobar','foo']，各自精确匹配
    expect(substituteSkillArgs(
      '$foobar $foo',
      'val1 val2',
      { skillDir: '/d', argNames: ['foobar', 'foo'] },
    )).toBe('val1 val2')
  })

  it('argNames 为空 → 不做命名替换，不影响 $ARGn', () => {
    expect(substituteSkillArgs('$ARG1 $name', 'hello', { skillDir: '/d', argNames: [] })).toBe('hello $name')
  })
})
