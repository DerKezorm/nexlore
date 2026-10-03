/** The editor's words in the reader's language, for the note page and for a canvas's text cards. */
import type { EditorLabels } from './editor'

export function editorLabels(t: (key: string) => string): EditorLabels {
  const s = (key: string) => t(`editor.slash.${key}`)
  return {
    placeholder: t('note.editorPlaceholder'),
    suggestions: t('editor.suggestions'),
    link: t('editor.link'),
    linkText: t('editor.linkText'),
    handle: { add: t('editor.handleAdd'), drag: t('editor.handleDrag') },
    dates: { list: t('editor.dates.list'), hint: t('editor.dates.hint') },
    code: {
      search: t('editor.code.search'), copy: t('editor.code.copy'), noResult: t('editor.code.noResult'),
      edit: t('editor.code.edit'), hide: t('editor.code.hide'), preview: t('editor.code.preview'),
      loading: t('common.loading'),
    },
    slash: {
      text: s('text'), h1: s('h1'), h2: s('h2'), h3: s('h3'), h4: s('h4'), h5: s('h5'), h6: s('h6'), quote: s('quote'), divider: s('divider'),
      bulletList: s('bulletList'), orderedList: s('orderedList'), taskList: s('taskList'), code: s('code'),
      table: s('table'), math: s('math'), groupText: s('groupText'), groupList: s('groupList'),
      groupAdvanced: s('groupAdvanced'), groupObsidian: s('groupObsidian'), callout: s('callout'),
      wikiLink: s('wikiLink'), embed: s('embed'), attachment: s('attachment'), image: s('image'),
    },
  }
}
