import path from 'node:path'

/** p（绝对路径）是否在某个 root（绝对目录）之内（含 root 自身、后代；无 .. 逃逸）。 */
export function isInsideWorkspace(p: string, roots: string[]): boolean {
  const abs = path.resolve(p)
  return roots.some(root => {
    const rel = path.relative(path.resolve(root), abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}
