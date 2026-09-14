import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { diffTokens } from './ChangeHighlightExtension'
import { useEditorStore } from '../../stores/editorStore'
import { resolveHarnessReview } from '../../lib/applyHarnessResult'

export interface AiDiffHighlightOptions {
  class: string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    aiDiffHighlight: {
      setAiHighlight: (from: number, to: number, deletedText?: string) => ReturnType
      clearAiHighlight: () => ReturnType
    }
  }
}

export const aiDiffHighlightPluginKey = new PluginKey('aiDiffHighlight')

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

function buildAiDecorations(doc: any, aiPendingEdit: { originalSelectedText?: string; highlightFrom?: number; selectionRange?: { from: number; to: number } | null; replacementText?: string; harness?: string }): DecorationSet {
  const decorations: Decoration[] = []
  const { originalSelectedText, highlightFrom, selectionRange, replacementText } = aiPendingEdit

  const from = highlightFrom ?? selectionRange?.from ?? 0
  const to = selectionRange?.to ?? (from + (replacementText?.length ?? 0))
  const safeFrom = Math.max(0, Math.min(from, doc.content.size))
  const safeTo = Math.max(safeFrom, Math.min(to, doc.content.size))

  if (originalSelectedText && originalSelectedText.trim().length > 0) {
    const insertedText = doc.textBetween(safeFrom, safeTo, '\n')
    const diffOps = diffTokens(originalSelectedText, insertedText)

    for (const dop of diffOps) {
      if (dop.type === 'delete' && dop.delText.length > 0) {
        const pos = Math.min(safeFrom + dop.charOffset, doc.content.size)
        if (dop.delText.includes('\n')) {
          decorations.push(Decoration.widget(pos, () => createDeletedBlock(dop.delText), { side: -1 }))
        } else {
          decorations.push(Decoration.widget(pos, () => createDeletedSpan(dop.delText), { side: -1 }))
        }
      } else if (dop.type === 'insert' && dop.insLen > 0) {
        const insStart = Math.min(safeFrom + dop.charOffset, doc.content.size)
        const insEnd = Math.min(insStart + dop.insLen, doc.content.size)
        if (insEnd > insStart) {
          decorations.push(
            Decoration.inline(insStart, insEnd, {
              class: 'diff-addition',
            })
          )
        }
      }
    }
  } else if (safeTo > safeFrom) {
    // Pure insertion: underline the newly added text cleanly
    decorations.push(
      Decoration.inline(safeFrom, safeTo, {
        class: 'diff-addition',
      })
    )
  }

  // Inline widget — sits in normal document flow before the edited passage
  const widget = document.createElement('div')
  widget.style.display = 'flex'
  widget.style.flexDirection = 'row'
  widget.style.alignItems = 'center'
  widget.style.gap = '2px'
  widget.style.padding = '2px'
  widget.style.marginBottom = '4px'
  widget.style.width = 'fit-content'
  widget.style.marginLeft = 'auto'
  widget.className =
    'bg-[var(--bg-elevated)] border border-[var(--border)] rounded-[8px] shadow-[0_4px_12px_rgba(0,0,0,0.06)] select-none animate-fade-in'

  widget.innerHTML = `
    <button class="accept-btn flex items-center justify-center w-6 h-6 rounded-[4px] text-[var(--text-accent)] hover:bg-[var(--bg-hover)] cursor-pointer transition-all active:scale-[0.9]" title="Accept changes (✓)">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><path d="M20 6 9 17l-5-5"></path></svg>
    </button>
    <div class="w-[1px] h-4 bg-[var(--border-subtle)]"></div>
    <button class="reject-btn flex items-center justify-center w-6 h-6 rounded-[4px] text-[var(--danger)] hover:bg-[var(--danger-bg)] cursor-pointer transition-all active:scale-[0.9]" title="Reject changes (✕)">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
    </button>
  `

    widget.querySelector('.accept-btn')?.addEventListener('click', (e) => {
      e.preventDefault()
      const state = useEditorStore.getState()
      if (state.aiPendingEdit?.harness) {
        resolveHarnessReview(true).catch((err) =>
          console.error('Failed to accept harness changes:', err)
        )
        return
      }
      state.editor?.commands.clearAiHighlight()
      state.setAiPendingEdit(null)
    })

    widget.querySelector('.reject-btn')?.addEventListener('click', (e) => {
      e.preventDefault()
      const state = useEditorStore.getState()
      if (state.aiPendingEdit?.harness) {
        resolveHarnessReview(false).catch((err) =>
          console.error('Failed to reject harness changes:', err)
        )
        return
      }
      const previous = state.aiPendingEdit?.previousContent
      state.editor?.commands.clearAiHighlight()
      if (previous !== undefined) {
        state.editor?.commands.setContent(previous)
        state.setContent(previous)
        if (state.currentFilePath) {
          state.updateFileContent(state.currentFilePath, previous)
        }
      }
      state.setAiPendingEdit(null)
    })

  decorations.push(Decoration.widget(safeFrom, widget, { side: -1 }))
  return DecorationSet.create(doc, decorations)
}

export const AiDiffHighlightExtension = Extension.create<AiDiffHighlightOptions>({
  name: 'aiDiffHighlight',

  addOptions() {
    return {
      class: 'ai-diff-block',
    }
  },

  addCommands() {
    return {
      setAiHighlight: (from, to, deletedText) => ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(aiDiffHighlightPluginKey, { action: 'set', from, to, deletedText })
        }
        return true
      },
      clearAiHighlight: () => ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(aiDiffHighlightPluginKey, { action: 'clear' })
        }
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: aiDiffHighlightPluginKey,
        state: {
          init() {
            return DecorationSet.empty
          },
          apply: (tr, oldState) => {
            const meta = tr.getMeta(aiDiffHighlightPluginKey)
            if (meta?.action === 'clear') {
              return DecorationSet.empty
            }

            const aiPendingEdit = useEditorStore.getState().aiPendingEdit

            if (meta?.action === 'set') {
              const { from, to, deletedText } = meta
              return buildAiDecorations(tr.doc, {
                originalSelectedText: deletedText ?? aiPendingEdit?.originalSelectedText,
                highlightFrom: from,
                selectionRange: { from, to },
                replacementText: aiPendingEdit?.replacementText,
              })
            }

            if (aiPendingEdit) {
              if (oldState === DecorationSet.empty || tr.docChanged) {
                return buildAiDecorations(tr.doc, aiPendingEdit)
              }
              return oldState.map(tr.mapping, tr.doc)
            }

            return oldState.map(tr.mapping, tr.doc)
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

