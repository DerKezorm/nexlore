/**
 * The AI's menu, the same in the editor's toolbar and in its context menu: the tasks the server knows, the tones of
 * rewriting (the server's list, `services/ai.py` TONES) and a list of languages to translate into. The language goes
 * to the server by its English name, which is all the server accepts there: letters, spaces and hyphens.
 */
import type { AiTask } from '../api/client'
import type { MenuItem } from './menu'

export const AI_TONES = ['formal', 'official', 'plain', 'factual', 'friendly', 'firm', 'calm', 'shorter', 'longer'] as const
export const AI_LANGUAGES = ['English', 'German', 'French', 'Spanish', 'Italian', 'Dutch', 'Polish', 'Portuguese', 'Turkish', 'Ukrainian'] as const

export type AiAsk = { task: AiTask; target: string }

export function aiMenu(t: (key: string) => string, ask: (what: AiAsk) => void): MenuItem[] {
  return [
    { label: t('ai.spelling'), onSelect: () => ask({ task: 'spelling', target: '' }) },
    { label: t('ai.rewrite'), items: AI_TONES.map((tone) => ({ label: t(`ai.tones.${tone}`), onSelect: () => ask({ task: 'rewrite', target: tone }) })) },
    {
      label: t('ai.translate'),
      items: AI_LANGUAGES.map((language) => ({ label: t(`ai.languages.${language}`), onSelect: () => ask({ task: 'translate', target: language }) })),
    },
    { label: t('ai.summarize'), onSelect: () => ask({ task: 'summarize', target: '' }) },
    { label: t('ai.write'), onSelect: () => ask({ task: 'write', target: '' }) },
  ]
}
