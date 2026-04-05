import type { AgentMemory } from '@jiku/types'

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'i', 'you', 'we', 'they',
  'dan', 'yang', 'di', 'ke', 'dari', 'ini', 'itu', 'dengan', 'untuk',
  'in', 'on', 'at', 'to', 'of', 'and', 'or', 'but', 'for', 'not',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
}

export function scoreMemory(
  memory: AgentMemory,
  currentInput: string,
  weights = { keyword: 0.5, recency: 0.3, access: 0.2 },
  halfLifeDays = 30,
): number {
  // 1. Keyword overlap
  const inputWords = new Set(tokenize(currentInput))
  const memWords = tokenize(memory.content)
  const overlap = memWords.filter(w => inputWords.has(w)).length
  const keywordScore = inputWords.size > 0 ? overlap / inputWords.size : 0

  // 2. Recency decay
  const lastSeen = memory.last_accessed ?? memory.created_at
  const ageDays = (Date.now() - new Date(lastSeen).getTime()) / 86_400_000
  const recencyScore = Math.exp(-ageDays / halfLifeDays)

  // 3. Access frequency
  const accessScore = Math.min(memory.access_count / 10, 1)

  // 4. Importance multiplier
  const importanceWeight: Record<string, number> = {
    high: 1.5, medium: 1.0, low: 0.6,
  }

  return (
    keywordScore * weights.keyword +
    recencyScore * weights.recency +
    accessScore  * weights.access
  ) * (importanceWeight[memory.importance] ?? 1.0)
}

export function findRelevantMemories(
  memories: AgentMemory[],
  currentInput: string,
  config: {
    max_extended: number
    min_score: number
    weights: { keyword: number; recency: number; access: number }
    recency_half_life_days: number
  },
): AgentMemory[] {
  return memories
    .map(m => ({
      memory: m,
      score: scoreMemory(m, currentInput, config.weights, config.recency_half_life_days),
    }))
    .filter(({ score }) => score >= config.min_score)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.max_extended)
    .map(({ memory }) => memory)
}
