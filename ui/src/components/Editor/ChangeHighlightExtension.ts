import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMParser, Node as ProsemirrorNode } from '@tiptap/pm/model'
import { useEditorStore } from '../../stores/editorStore'
import { useSettingsStore } from '../../stores/settingsStore'

export const changeHighlightPluginKey = new PluginKey('changeHighlight')

// ─── Token & Block diffing helpers ───────────────────────────────────────────

type Tag = 'equal' | 'replace' | 'delete' | 'insert'

interface BlockOp {
  tag: Tag
  i1: number
  i2: number
  j1: number
  j2: number
}

interface DocBlock {
  pos: number
  nodeSize: number
  text: string
}

interface DiffOp {
  type: 'equal' | 'delete' | 'insert'
  delText: string
  insText: string
  charOffset: number
  insLen: number
}

function tokenize(text: string): string[] {
  // Matches word tokens (with trailing whitespace), punctuation (with trailing whitespace), or lone whitespace runs
  return text.match(/[\p{L}\p{N}]+[^\S\r\n]*|[^\p{L}\p{N}\s]+[^\S\r\n]*|\s+/gu) || []
}

function levenshtein(a: string, b: string): number {
  const n = a.length
  const m = b.length
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    }
  }
  return d[n][m]
}

function getWordOnly(token: string): string {
  const m = token.match(/^[\p{L}\p{N}]+/u)
  return m ? m[0] : ''
}

function isIntraWordEdit(baseToken: string, currToken: string): boolean {
  const baseWord = getWordOnly(baseToken)
  const currWord = getWordOnly(currToken)
  if (!baseWord || !currWord) return false
  if (baseWord === currWord) return true

  const minLen = Math.min(baseWord.length, currWord.length)
  const maxLen = Math.max(baseWord.length, currWord.length)

  // Exact prefix match (e.g. walk -> walking, running -> run)
  if (baseWord.startsWith(currWord) || currWord.startsWith(baseWord)) {
    return true
  }

  // Exact suffix match (e.g. national -> international)
  if (baseWord.endsWith(currWord) || currWord.endsWith(baseWord)) {
    return true
  }

  // Small typo/edit distance relative to word length (e.g. recieve -> receive, wnd -> wind)
  const dist = levenshtein(baseWord, currWord)
  if (dist <= 2 && minLen >= 3 && dist / maxLen <= 0.35) {
    return true
  }

  return false
}

function diffStringsCharLevel(aStr: string, bStr: string): Array<{ type: 'equal' | 'delete' | 'insert'; delText: string; insText: string }> {
  const a = Array.from(aStr)
  const b = Array.from(bStr)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  let i = 0
  let j = 0
  const raw: Array<{ type: 'equal' | 'delete' | 'insert'; i1: number; i2: number; j1: number; j2: number }> = []

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ type: 'equal', i1: i, i2: i + 1, j1: j, j2: j + 1 })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: 'delete', i1: i, i2: i + 1, j1: j, j2: j })
      i++
    } else {
      raw.push({ type: 'insert', i1: i, i2: i, j1: j, j2: j + 1 })
      j++
    }
  }
  while (i < n) {
    raw.push({ type: 'delete', i1: i, i2: i + 1, j1: j, j2: j })
    i++
  }
  while (j < m) {
    raw.push({ type: 'insert', i1: i, i2: i, j1: j, j2: j + 1 })
    j++
  }

  const ops: Array<{ type: 'equal' | 'delete' | 'insert'; delText: string; insText: string }> = []
  for (let k = 0; k < raw.length; k++) {
    const cur = raw[k]
    let i1 = cur.i1
    let i2 = cur.i2
    let j1 = cur.j1
    let j2 = cur.j2
    while (k + 1 < raw.length && raw[k + 1].type === cur.type) {
      k++
      i2 = raw[k].i2
      j2 = raw[k].j2
    }
    ops.push({
      type: cur.type,
      delText: a.slice(i1, i2).join(''),
      insText: b.slice(j1, j2).join(''),
    })
  }
  return ops
}

function diffTokens(baseText: string, currText: string): DiffOp[] {
  const a = tokenize(baseText)
  const b = tokenize(currText)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  let i = 0
  let j = 0
  const raw: BlockOp[] = []

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ tag: 'equal', i1: i, i2: i + 1, j1: j, j2: j + 1 })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ tag: 'delete', i1: i, i2: i + 1, j1: j, j2: j })
      i++
    } else {
      raw.push({ tag: 'insert', i1: i, i2: i, j1: j, j2: j + 1 })
      j++
    }
  }
  while (i < n) {
    raw.push({ tag: 'delete', i1: i, i2: i + 1, j1: j, j2: j })
    i++
  }
  while (j < m) {
    raw.push({ tag: 'insert', i1: i, i2: i, j1: j, j2: j + 1 })
    j++
  }

  // Merge adjacent change operations
  const grouped: BlockOp[] = []
  for (const op of raw) {
    const prev = grouped[grouped.length - 1]
    if (!prev) {
      grouped.push({ ...op })
      continue
    }
    if (prev.tag === 'equal' && op.tag === 'equal') {
      prev.i2 = op.i2
      prev.j2 = op.j2
    } else if (prev.tag !== 'equal' && op.tag !== 'equal') {
      prev.tag = 'replace'
      prev.i2 = Math.max(prev.i2, op.i2)
      prev.j2 = Math.max(prev.j2, op.j2)
    } else {
      grouped.push({ ...op })
    }
  }

  const finalOps: DiffOp[] = []
  let currCharOffset = 0

  for (const op of grouped) {
    const delTokens = a.slice(op.i1, op.i2)
    const insTokens = b.slice(op.j1, op.j2)
    const delText = delTokens.join('')
    const insText = insTokens.join('')

    if (op.tag === 'equal') {
      finalOps.push({
        type: 'equal',
        delText: '',
        insText: '',
        charOffset: currCharOffset,
        insLen: insText.length,
      })
      currCharOffset += insText.length
    } else if (op.tag === 'insert') {
      let iText = insText
      let trailingSpace = ''
      const iMatch = iText.match(/\s+$/)
      if (iMatch) {
        trailingSpace = iMatch[0]
        iText = iText.slice(0, -trailingSpace.length)
      }

      if (iText.length > 0) {
        finalOps.push({
          type: 'insert',
          delText: '',
          insText: iText,
          charOffset: currCharOffset,
          insLen: iText.length,
        })
        currCharOffset += iText.length
      }
      if (trailingSpace.length > 0) {
        finalOps.push({
          type: 'equal',
          delText: '',
          insText: trailingSpace,
          charOffset: currCharOffset,
          insLen: trailingSpace.length,
        })
        currCharOffset += trailingSpace.length
      }
    } else if (op.tag === 'delete') {
      let dText = delText
      const dMatch = dText.match(/\s+$/)
      if (dMatch) {
        dText = dText.slice(0, -dMatch[0].length)
      }
      if (dText.length > 0) {
        finalOps.push({
          type: 'delete',
          delText: dText,
          insText: '',
          charOffset: currCharOffset,
          insLen: 0,
        })
      }
    } else if (op.tag === 'replace') {
      // Check if this is a single word edit (e.g. 1 base token vs 1 curr token and isIntraWordEdit)
      if (delTokens.length === 1 && insTokens.length === 1 && isIntraWordEdit(delTokens[0], insTokens[0])) {
        // Run intra-word character diff
        const charDiffs = diffStringsCharLevel(delTokens[0], insTokens[0])
        let intraOffset = 0
        for (const cd of charDiffs) {
          if (cd.type === 'equal') {
            intraOffset += cd.insText.length
          } else if (cd.type === 'insert') {
            finalOps.push({
              type: 'insert',
              delText: '',
              insText: cd.insText,
              charOffset: currCharOffset + intraOffset,
              insLen: cd.insText.length,
            })
            intraOffset += cd.insText.length
          } else if (cd.type === 'delete') {
            finalOps.push({
              type: 'delete',
              delText: cd.delText,
              insText: '',
              charOffset: currCharOffset + intraOffset,
              insLen: 0,
            })
          }
        }
        currCharOffset += insText.length
      } else {
        // Whole word / phrase replacement:
        // Factor out common or trailing whitespace so neither strikethrough nor underline bleed into trailing space
        let dText = delText
        let iText = insText
        let trailingSpace = ''

        const dMatch = dText.match(/\s+$/)
        const iMatch = iText.match(/\s+$/)
        if (dMatch && iMatch) {
          const commonSpaceLen = Math.min(dMatch[0].length, iMatch[0].length)
          trailingSpace = iMatch[0].slice(0, commonSpaceLen)
          dText = dText.slice(0, -commonSpaceLen)
          iText = iText.slice(0, -commonSpaceLen)
        } else if (dMatch) {
          dText = dText.slice(0, -dMatch[0].length)
        } else if (iMatch) {
          trailingSpace = iMatch[0]
          iText = iText.slice(0, -trailingSpace.length)
        }

        if (dText.length > 0) {
          finalOps.push({
            type: 'delete',
            delText: dText,
            insText: '',
            charOffset: currCharOffset,
            insLen: 0,
          })
        }
        if (iText.length > 0) {
          finalOps.push({
            type: 'insert',
            delText: '',
            insText: iText,
            charOffset: currCharOffset,
            insLen: iText.length,
          })
          currCharOffset += iText.length
        }
        if (trailingSpace.length > 0) {
          finalOps.push({
            type: 'equal',
            delText: '',
            insText: trailingSpace,
            charOffset: currCharOffset,
            insLen: trailingSpace.length,
          })
          currCharOffset += trailingSpace.length
        }
      }
    }
  }

  return finalOps
}

function getBaseBlocks(editor: any, baseContent: string): string[] {
  if (!baseContent) return []
  try {
    const parser = editor?.storage?.markdown?.parser
    if (parser && editor?.schema) {
      const html = parser.parse(baseContent)
      const element = document.createElement('div')
      element.innerHTML = typeof html === 'string' ? html : ''
      const baseDoc = DOMParser.fromSchema(editor.schema).parse(element)
      const blocks: string[] = []
      baseDoc.descendants((child) => {
        if (child.isTextblock) {
          blocks.push(child.textContent)
          return false
        }
        return true
      })
      if (blocks.length > 0) return blocks
    }
  } catch (e) {
    console.warn('Failed to parse baseContent with markdown parser, falling back to regex:', e)
  }

  // Fallback: strip markdown formatting prefixes for headings (# ), blockquotes (> ), lists (- , * , 1. )
  return baseContent
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^(#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/gm, '').trim())
    .filter((p) => p.length > 0)
}

function extractTextBlocks(doc: ProsemirrorNode): DocBlock[] {
  const blocks: DocBlock[] = []
  doc.descendants((child, pos) => {
    if (child.isTextblock) {
      blocks.push({
        pos,
        nodeSize: child.nodeSize,
        text: child.textContent,
      })
      return false
    }
    return true
  })
  return blocks
}

function diffBlockSequences(a: string[], b: string[]): BlockOp[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  let i = 0
  let j = 0
  const raw: BlockOp[] = []

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ tag: 'equal', i1: i, i2: i + 1, j1: j, j2: j + 1 })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ tag: 'delete', i1: i, i2: i + 1, j1: j, j2: j })
      i++
    } else {
      raw.push({ tag: 'insert', i1: i, i2: i, j1: j, j2: j + 1 })
      j++
    }
  }
  while (i < n) {
    raw.push({ tag: 'delete', i1: i, i2: i + 1, j1: j, j2: j })
    i++
  }
  while (j < m) {
    raw.push({ tag: 'insert', i1: i, i2: i, j1: j, j2: j + 1 })
    j++
  }

  // Merge adjacent change operations into grouped blocks
  const grouped: BlockOp[] = []
  for (const op of raw) {
    const prev = grouped[grouped.length - 1]
    if (!prev) {
      grouped.push({ ...op })
      continue
    }
    if (prev.tag === 'equal' && op.tag === 'equal') {
      prev.i2 = op.i2
      prev.j2 = op.j2
    } else if (prev.tag !== 'equal' && op.tag !== 'equal') {
      prev.tag = 'replace'
      prev.i2 = Math.max(prev.i2, op.i2)
      prev.j2 = Math.max(prev.j2, op.j2)
    } else {
      grouped.push({ ...op })
    }
  }

  return grouped
}

function createDeletedSpan(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'diff-deletion'
  span.textContent = text
  span.style.pointerEvents = 'none'
  span.style.userSelect = 'none'
  return span
}

function createDeletedBlock(text: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'diff-deletion-block'
  div.textContent = text
  div.style.pointerEvents = 'none'
  div.style.userSelect = 'none'
  return div
}

export const ChangeHighlightExtension = Extension.create({
  name: 'changeHighlight',

  addProseMirrorPlugins() {
    const editor = this.editor

    return [
      new Plugin({
        key: changeHighlightPluginKey,
        state: {
          init() {
            return DecorationSet.empty
          },
          apply: (_tr, _oldSet, _oldState, newState) => {
            const editorState = useEditorStore.getState()
            const settings = useSettingsStore.getState().settings

            // When reviewing an AI-generated edit, suppress standard git/snapshot diff decorations
            // so the AI diff (contiguous deletion of old text + contiguous addition of new text) is displayed cleanly
            if (editorState.aiPendingEdit) {
              return DecorationSet.empty
            }

            const baseContent = editorState.diffBaseContent
            const showAdditions = (settings?.show_additions !== false) && editorState.documentShowAdditions
            const showDeletions = (settings?.show_deletions !== false) && editorState.documentShowDeletions

            const doc = newState.doc
            const currentBlocks = extractTextBlocks(doc)

            if (baseContent === null) {
              const hasText = doc.textContent.trim().length > 0
              if (editorState.hasDiffChanges !== hasText) {
                editorState.setHasDiffChanges(hasText)
              }
              return DecorationSet.empty
            }
            const baseBlocks = getBaseBlocks(editor, baseContent)

            // If base is empty and current is empty, no diff
            if (baseBlocks.length === 0 && currentBlocks.length === 0) {
              if (editorState.hasDiffChanges) {
                editorState.setHasDiffChanges(false)
              }
              return DecorationSet.empty
            }

            const blockOps = diffBlockSequences(baseBlocks, currentBlocks.map((b) => b.text))
            const hasChanges = blockOps.some((op) => op.tag !== 'equal')

            if (editorState.hasDiffChanges !== hasChanges) {
              editorState.setHasDiffChanges(hasChanges)
            }

            if (!showAdditions && !showDeletions) {
              return DecorationSet.empty
            }

            const decorations: Decoration[] = []

            for (const op of blockOps) {
              if (op.tag === 'equal') {
                continue
              }

              if (op.tag === 'insert') {
                if (showAdditions) {
                  for (let j = op.j1; j < op.j2; j++) {
                    const block = currentBlocks[j]
                    if (block && block.text.length > 0) {
                      decorations.push(
                        Decoration.inline(block.pos + 1, block.pos + block.nodeSize - 1, {
                          class: 'diff-addition',
                        })
                      )
                    }
                  }
                }
                continue
              }

              if (op.tag === 'delete') {
                if (showDeletions) {
                  const targetPos = op.j1 < currentBlocks.length ? currentBlocks[op.j1].pos : doc.content.size
                  const deletedText = baseBlocks.slice(op.i1, op.i2).join('\n\n')
                  if (deletedText.length > 0) {
                    decorations.push(
                      Decoration.widget(targetPos, () => createDeletedBlock(deletedText), { side: -1 })
                    )
                  }
                }
                continue
              }

              if (op.tag === 'replace') {
                const baseCount = op.i2 - op.i1
                const currCount = op.j2 - op.j1
                const pairCount = Math.min(baseCount, currCount)

                // Diff paired blocks using word-level diffing with intra-word refinement
                for (let k = 0; k < pairCount; k++) {
                  const baseText = baseBlocks[op.i1 + k]
                  const currBlock = currentBlocks[op.j1 + k]
                  if (!currBlock) continue

                  const diffOps = diffTokens(baseText, currBlock.text)
                  for (const dop of diffOps) {
                    if (dop.type === 'insert' && showAdditions && dop.insLen > 0) {
                      const from = currBlock.pos + 1 + dop.charOffset
                      const to = from + dop.insLen
                      decorations.push(
                        Decoration.inline(from, to, {
                          class: 'diff-addition',
                        })
                      )
                    } else if (dop.type === 'delete' && showDeletions && dop.delText.length > 0) {
                      const pos = currBlock.pos + 1 + dop.charOffset
                      decorations.push(
                        Decoration.widget(pos, () => createDeletedSpan(dop.delText), { side: -1 })
                      )
                    }
                  }
                }

                // Handle any extra deleted base blocks
                if (baseCount > currCount && showDeletions) {
                  const extraDeletedText = baseBlocks.slice(op.i1 + pairCount, op.i2).join('\n\n')
                  if (extraDeletedText.length > 0) {
                    const targetPos = op.j2 < currentBlocks.length ? currentBlocks[op.j2].pos : doc.content.size
                    decorations.push(
                      Decoration.widget(targetPos, () => createDeletedBlock(extraDeletedText), { side: -1 })
                    )
                  }
                }

                // Handle any extra inserted current blocks
                if (currCount > baseCount && showAdditions) {
                  for (let j = op.j1 + pairCount; j < op.j2; j++) {
                    const block = currentBlocks[j]
                    if (block && block.text.length > 0) {
                      decorations.push(
                        Decoration.inline(block.pos + 1, block.pos + block.nodeSize - 1, {
                          class: 'diff-addition',
                        })
                      )
                    }
                  }
                }
              }
            }

            return DecorationSet.create(doc, decorations)
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
        },
      }),
    ]
  },
})


