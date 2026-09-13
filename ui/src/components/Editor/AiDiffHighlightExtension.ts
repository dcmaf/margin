import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

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
            let newState = oldState.map(tr.mapping, tr.doc)
            const meta = tr.getMeta(aiDiffHighlightPluginKey)

            if (meta) {
              if (meta.action === 'clear') {
                return DecorationSet.empty
              }
              if (meta.action === 'set') {
                const { from, to, deletedText } = meta
                const decorations: Decoration[] = []

                if (deletedText) {
                  // Show the old active selection content as deleted text
                  if (deletedText.includes('\n')) {
                    decorations.push(Decoration.widget(from, () => createDeletedBlock(deletedText), { side: -1 }))
                  } else {
                    decorations.push(Decoration.widget(from, () => createDeletedSpan(deletedText), { side: -1 }))
                  }

                  // Show the new replacement as inserted text
                  if (to > from) {
                    decorations.push(
                      Decoration.inline(from, to, {
                        class: 'diff-addition',
                      })
                    )
                  }
                } else {
                  // Fallback for full-block harness highlight
                  tr.doc.nodesBetween(from, to, (node, pos) => {
                    if (node.isBlock && node.type.name !== 'doc') {
                      decorations.push(
                        Decoration.node(pos, pos + node.nodeSize, {
                          class: this.options.class,
                        })
                      )
                      return false
                    }
                    return true
                  })
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

                // Dynamic import avoids circular dependency issues during plugin eval
                import('../../stores/editorStore').then(({ useEditorStore }) => {
                  widget.querySelector('.accept-btn')?.addEventListener('click', (e) => {
                    e.preventDefault()
                    const state = useEditorStore.getState()
                    if (state.aiPendingEdit?.harness) {
                      import('../../lib/applyHarnessResult').then(({ resolveHarnessReview }) => {
                        resolveHarnessReview(true).catch((err) =>
                          console.error('Failed to accept harness changes:', err)
                        )
                      })
                      return
                    }
                    state.editor?.commands.clearAiHighlight()
                    state.setAiPendingEdit(null)
                  })

                  widget.querySelector('.reject-btn')?.addEventListener('click', (e) => {
                    e.preventDefault()
                    const state = useEditorStore.getState()
                    if (state.aiPendingEdit?.harness) {
                      import('../../lib/applyHarnessResult').then(({ resolveHarnessReview }) => {
                        resolveHarnessReview(false).catch((err) =>
                          console.error('Failed to reject harness changes:', err)
                        )
                      })
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
                })

                // side: -1 inserts the widget BEFORE the character at `from`
                decorations.push(Decoration.widget(from, widget, { side: -1 }))

                return DecorationSet.create(tr.doc, decorations)
              }
            }

            return newState
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

