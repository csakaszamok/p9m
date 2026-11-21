// Types of report.mjs for its vitest test (the module itself is plain JavaScript, run by node in CI)
export function parseKnown(text: string): Map<string, string>
export function classify(id: string, known: Map<string, string>): { fatal: boolean; issue?: string }
export function unseen(known: Map<string, string>, seen: Set<string>, prefix: 'soak' | 'durability'): string[]
