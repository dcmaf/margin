import React, { useState, useEffect, useCallback, useRef } from 'react'
import { X, GitCommit, Sparkles, Loader2 } from 'lucide-react'
import { API_BASE } from '../lib/api'

interface CommitDialogProps {
  isOpen: boolean
  onClose: () => void
  onCommit: (title: string, comment: string) => Promise<void>
  filePath: string
  baseContent: string | null
  currentContent: string
  isCommitting?: boolean
}

export const CommitDialog: React.FC<CommitDialogProps> = ({
  isOpen,
  onClose,
  onCommit,
  filePath,
  baseContent,
  currentContent,
  isCommitting = false,
}) => {
  const [title, setTitle] = useState('')
  const [comment, setComment] = useState('')
  const [isAiGenerating, setIsAiGenerating] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const hasUserEditedRef = useRef(false)

  const fileName = filePath.split('/').pop() || filePath

  const generateCommitMessage = useCallback(async (force = false) => {
    if (!filePath) return
    setIsAiGenerating(true)
    setAiError(null)

    try {
      const res = await fetch(`${API_BASE}/api/workspace/generate-commit-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: filePath,
          base_content: baseContent,
          current_content: currentContent,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        let parsedTitle = (data.title || '').trim()
        let parsedComment = (data.comment || '').trim()

        // Fallback safety if title contains raw JSON or JSON keys
        if (
          parsedTitle.startsWith('{') ||
          parsedTitle.includes('"title":') ||
          parsedTitle.includes('"comment":')
        ) {
          try {
            const parsed = JSON.parse(parsedTitle)
            parsedTitle = String(parsed.title || parsed.commit_title || parsed.subject || parsedTitle).trim()
            if (!parsedComment && (parsed.comment || parsed.description || parsed.body)) {
              parsedComment = String(parsed.comment || parsed.description || parsed.body).trim()
            }
          } catch {
            const tMatch = parsedTitle.match(/["'](?:title|commit_title|subject)["']\s*:\s*["']([\s\S]*?)["']/)
            const cMatch = parsedTitle.match(/["'](?:comment|description|body)["']\s*:\s*["']([\s\S]*?)["']/)
            if (tMatch) parsedTitle = tMatch[1].trim()
            if (cMatch && !parsedComment) parsedComment = cMatch[1].trim()
          }
        }

        // Clean any residual braces or quotes from title
        parsedTitle = parsedTitle.replace(/^[{\["']+|[}\]\,"']+$/g, '').trim()
        parsedTitle = parsedTitle.replace(/^["']?title["']?\s*:\s*["']?/i, '').trim()
        parsedTitle = parsedTitle.replace(/["']\s*,\s*["']?(?:comment|description)["']?\s*:.*$/i, '').trim()
        parsedTitle = parsedTitle.replace(/^["'{}]+|["'{}]+$/g, '').trim()

        if (parsedTitle && (!hasUserEditedRef.current || force)) {
          setTitle(parsedTitle)
          setComment(parsedComment)
        }
      } else {
        const errData = await res.json().catch(() => null)
        setAiError(errData?.detail || 'Failed to generate commit message')
      }
    } catch (err) {
      console.error('Failed to generate commit message:', err)
      setAiError('Network error while generating commit message')
    } finally {
      setIsAiGenerating(false)
    }
  }, [filePath, baseContent, currentContent])

  useEffect(() => {
    if (isOpen) {
      hasUserEditedRef.current = false
      setTitle('')
      setComment('')
      generateCommitMessage(false)
      setTimeout(() => {
        titleInputRef.current?.focus()
      }, 100)
    }
  }, [isOpen, generateCommitMessage])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCommitting) {
        onClose()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (title.trim() && !isCommitting) {
          onCommit(title.trim(), comment.trim())
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, onCommit, title, comment, isCommitting])

  if (!isOpen) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || isCommitting) return
    onCommit(title.trim(), comment.trim())
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45 backdrop-blur-[2px] animate-fade-in select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isCommitting) onClose()
      }}
    >
      <div className="bg-[var(--bg)] border border-[var(--border-subtle)] rounded-[12px] shadow-2xl w-full max-w-lg overflow-hidden text-[var(--text)] animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-hover)]/30">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-[var(--accent-green-bg)] text-[var(--accent-green)] flex items-center justify-center">
              <GitCommit className="w-3.5 h-3.5" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-[var(--text-heading)]">Commit Changes</h3>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-hover)] px-2 py-0.5 rounded-[4px] border border-[var(--border-subtle)]">
              {fileName}
            </span>
            <button
              onClick={onClose}
              disabled={isCommitting}
              className="text-[var(--text-muted)] hover:text-[var(--text-heading)] p-1 rounded-[4px] hover:bg-[var(--bg-hover)] transition-all cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit}>
          <div className="p-4 space-y-3.5">
            {/* AI Generation Status / Prompt Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                {isAiGenerating ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 text-[var(--accent-brown)] animate-spin" />
                    <span>AI is drafting commit message...</span>
                  </>
                ) : aiError ? (
                  <span className="text-[var(--danger)] text-[10px]">{aiError}</span>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5 text-[var(--accent-brown)]" />
                    <span className="text-[10px] text-[var(--text-muted)]">Pre-populated by AI from document diff</span>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={() => generateCommitMessage(true)}
                disabled={isAiGenerating || isCommitting}
                className="text-[10px] text-[var(--accent-brown)] hover:text-[var(--accent-brown-hover)] font-medium flex items-center gap-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:underline"
              >
                <Sparkles className="w-2.5 h-2.5" />
                <span>Regenerate</span>
              </button>
            </div>

            {/* Commit Title Input */}
            <div className="space-y-1">
              <label htmlFor="commit-title" className="block text-[11px] font-medium text-[var(--text-heading)]">
                Commit Title <span className="text-[var(--danger)]">*</span>
              </label>
              <div className="relative">
                <input
                  ref={titleInputRef}
                  id="commit-title"
                  type="text"
                  value={title}
                  onChange={(e) => {
                    hasUserEditedRef.current = true
                    setTitle(e.target.value)
                  }}
                  placeholder={isAiGenerating ? 'Drafting title...' : 'e.g. feat(ch01): introduce backstory...'}
                  disabled={isCommitting}
                  maxLength={120}
                  className="w-full px-3 py-1.5 bg-[var(--bg-editor)] border border-[var(--border-subtle)] focus:border-[var(--assist-focus-ring)] rounded-[6px] text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none transition-all shadow-inner"
                />
              </div>
            </div>

            {/* Commit Description / Comment Textarea */}
            <div className="space-y-1">
              <label htmlFor="commit-comment" className="block text-[11px] font-medium text-[var(--text-heading)]">
                Commit Description <span className="text-[10px] text-[var(--text-muted)] font-normal">(Optional)</span>
              </label>
              <textarea
                id="commit-comment"
                value={comment}
                onChange={(e) => {
                  hasUserEditedRef.current = true
                  setComment(e.target.value)
                }}
                placeholder={isAiGenerating ? 'Drafting description...' : 'Add additional notes, chapter context, or details...'}
                disabled={isCommitting}
                rows={4}
                className="w-full px-3 py-2 bg-[var(--bg-editor)] border border-[var(--border-subtle)] focus:border-[var(--assist-focus-ring)] rounded-[6px] text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none transition-all resize-none shadow-inner leading-relaxed"
              />
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-hover)]/20">
            <span className="text-[10px] text-[var(--text-muted)]">
              Press <kbd className="px-1 py-0.5 rounded bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[9px]">⌘+Enter</kbd> to commit
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isCommitting}
                className="px-3 py-1.5 rounded-[6px] text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-heading)] hover:bg-[var(--bg-hover)] border border-transparent hover:border-[var(--border-subtle)] transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim() || isCommitting}
                className="px-3 py-1.5 rounded-[6px] text-xs font-medium bg-[var(--accent-brown)] text-white hover:bg-[var(--accent-brown-hover)] transition-all flex items-center gap-1.5 shadow-sm cursor-pointer active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <GitCommit className={`w-3.5 h-3.5 ${isCommitting ? 'animate-spin' : ''}`} />
                <span>{isCommitting ? 'Committing...' : 'Commit Changes'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
