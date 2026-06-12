// src/todo.ts
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 任务清单 + 走神检测：连续 3 轮（loop turn）未更新且有未完成项 → 周期性提醒。
 *  tick() 在执行了 TodoWrite 的同一轮末尾也会跑，所以阈值把更新轮自身计入（实际节奏 = 更新轮 + 2 个空轮后首次提醒）。 */
export class TodoStore {
  items: TodoItem[] = []
  private lastUpdateTurn = 0
  private currentTurn = 0

  set(items: TodoItem[]): void {
    this.items = items
    this.lastUpdateTurn = this.currentTurn
  }

  /** 每个 loop turn 由调用方推进一次 */
  tick(): void { this.currentTurn++ }

  reset(): void { this.items = []; this.lastUpdateTurn = 0; this.currentTurn = 0 }

  /** 到提醒节奏（每 3 轮一次）则返回提醒文本，否则 null */
  staleReminder(): string | null {
    const open = this.items.filter(i => i.status !== 'completed')
    const delta = this.currentTurn - this.lastUpdateTurn
    if (!open.length || delta < 3 || delta % 3 !== 0) return null
    return `Todo 清单已 ${delta} 轮未更新。未完成项：\n${open.map(i => `- [${i.status}] ${i.content}`).join('\n')}\n请对照清单检查当前进度，完成一项就用 TodoWrite 更新状态；若计划已变化，重写清单。`
  }
}
