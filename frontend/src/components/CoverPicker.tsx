/**
 * Choosing a folder's cover for the cover flow: a drawn motif in any hue, a picture of one's own, a picture already in
 * the space, or none (then the card shows a pattern in the folder's colour). The cover has a fixed shape, three by
 * four; a picture is cut to it, the slider moves the part that stays. The preview shows what is kept: the server cuts
 * the same way (`services/covers.py`).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, coverflowApi, coverUrl, fileUrl, vaultApi, type CoverFolder } from '../api/client'
import { MOTIFS, motifPicture, motifUrl, seedOf, type Motif } from '../lib/coverArt'
import { useDialogFocus } from '../lib/dialogFocus'
import { errorText } from '../lib/errors'
import { Symbol } from './Symbol'

type Choice =
  | { kind: 'current' }
  | { kind: 'motif'; motif: Motif }
  | { kind: 'file'; file: File; url: string }
  | { kind: 'vault'; path: string }
  | { kind: 'none' }

const PICTURE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i

export function CoverPicker({ folder, colour, onClose, onSaved }: {
  folder: CoverFolder
  colour: string
  onClose: () => void
  onSaved: (cover: number | null) => void
}) {
  const { t } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const dismiss = useDialogFocus(box, onClose)
  const [choice, setChoice] = useState<Choice>(folder.cover ? { kind: 'current' } : { kind: 'none' })
  const [hue, setHue] = useState(() => seedOf(folder.name) % 360)
  const [focus, setFocus] = useState(50)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [pictures, setPictures] = useState<string[] | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const upload = useRef<HTMLInputElement>(null)
  const seed = seedOf(folder.name)
  const space = folder.path.split('/')[0]

  useEffect(() => () => {
    if (choice.kind === 'file') URL.revokeObjectURL(choice.url)
  }, [choice])

  useEffect(() => {
    if (!browsing || pictures) return
    vaultApi.attachments(space).then(
      ({ items }) => {
        // Pictures of this folder first, then the rest of the space.
        const found = items.map((item) => item.path).filter((path) => PICTURE.test(path))
        const inside = (path: string) => path.startsWith(folder.path + '/')
        setPictures([...found.filter(inside), ...found.filter((path) => !inside(path))].slice(0, 60))
      },
      () => setPictures([]),
    )
  }, [browsing, pictures, space, folder.path])

  const preview = useMemo((): string | null => {
    if (choice.kind === 'current') return folder.cover ? coverUrl(folder.path, folder.cover) : null
    if (choice.kind === 'motif') return motifUrl(choice.motif, hue, seed)
    if (choice.kind === 'file') return choice.url
    if (choice.kind === 'vault') return fileUrl(choice.path)
    return null
  }, [choice, hue, seed, folder])
  const cuts = choice.kind === 'file' || choice.kind === 'vault'

  const save = async () => {
    setBusy(true)
    setProblem(null)
    try {
      if (choice.kind === 'current') return onSaved(folder.cover)
      if (choice.kind === 'none') {
        if (folder.cover) await coverflowApi.removeCover(folder.path)
        return onSaved(null)
      }
      const made =
        choice.kind === 'motif'
          ? await coverflowApi.setCover(folder.path, await motifPicture(choice.motif, hue, seed))
          : choice.kind === 'file'
            ? await coverflowApi.setCover(folder.path, choice.file, focus)
            : await coverflowApi.coverFrom(folder.path, choice.path, focus)
      onSaved(made.cover)
    } catch (error) {
      setProblem(error instanceof ApiError ? errorText(error.code, error.values) : errorText('internal_error'))
    } finally {
      setBusy(false)
    }
  }

  const tile = 'relative aspect-[3/4] overflow-hidden rounded-lg border-2 bg-cover bg-center '
  const chosen = (yes: boolean) => (yes ? 'border-accent-500 ring-2 ring-accent-500/30' : 'border-transparent hover:border-ink-600')

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/60 p-3 backdrop-blur-sm" onClick={(event) => event.target === event.currentTarget && dismiss()}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="cover-picker-title" className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 text-mist-100 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-5 py-3.5">
          <Symbol name="image" />
          <h2 id="cover-picker-title" className="min-w-0 flex-1 truncate text-base font-semibold">{t('coverflow.picker.title', { name: folder.name })}</h2>
          <button type="button" onClick={dismiss} aria-label={t('common.close')} className="grid h-8 w-8 place-items-center rounded-full hover:bg-ink-850">
            <Symbol name="close" />
          </button>
        </div>
        <div className="grid min-h-0 gap-6 overflow-y-auto p-5 sm:grid-cols-[220px_1fr]">
          <div className="relative aspect-[3/4] w-full max-w-[220px] self-start overflow-hidden rounded-2xl justify-self-center" data-testid="cover-preview">
            {preview ? (
              <div className="absolute inset-0 bg-cover" style={{ backgroundImage: `url("${preview}")`, backgroundPosition: cuts ? `${focus}% ${focus}%` : 'center' }} />
            ) : (
              <div className="nn-cf-pattern absolute inset-0" style={{ '--tint': colour } as CSSProperties} />
            )}
            <div className="nn-cf-shade" />
            <div className="absolute inset-x-3.5 bottom-3.5 text-white">
              <b className="block truncate text-xl font-bold">{folder.name}</b>
            </div>
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-mist-600 uppercase">{t('coverflow.picker.motif')}</h3>
            <div className="mb-4 grid grid-cols-5 gap-2">
              {MOTIFS.map((motif) => (
                <button
                  key={motif}
                  type="button"
                  aria-pressed={choice.kind === 'motif' && choice.motif === motif}
                  onClick={() => setChoice({ kind: 'motif', motif })}
                  className={tile + chosen(choice.kind === 'motif' && choice.motif === motif)}
                  style={{ backgroundImage: `url("${motifUrl(motif, hue, seed)}")` }}
                >
                  <span className="absolute inset-x-0 bottom-0 bg-black/50 py-0.5 text-center text-[10.5px] text-white">{t(`coverflow.motifs.${motif}`)}</span>
                </button>
              ))}
              <button
                type="button"
                aria-pressed={choice.kind === 'none'}
                onClick={() => setChoice({ kind: 'none' })}
                className={tile + 'nn-cf-pattern ' + chosen(choice.kind === 'none')}
                style={{ '--tint': colour } as CSSProperties}
              >
                <span className="absolute inset-x-0 bottom-0 bg-black/50 py-0.5 text-center text-[10.5px] text-white">{t('coverflow.picker.none')}</span>
              </button>
            </div>
            <label className="mb-4 flex items-center gap-3 text-sm text-mist-400">
              <span className="w-24 shrink-0">{t('coverflow.picker.hue')}</span>
              <input
                type="range"
                min={0}
                max={359}
                value={hue}
                onChange={(event) => setHue(Number(event.target.value))}
                className="h-2 flex-1 cursor-pointer appearance-none rounded-full"
                style={{ background: 'linear-gradient(90deg,hsl(0 70% 55%),hsl(60 70% 55%),hsl(120 70% 55%),hsl(180 70% 55%),hsl(240 70% 55%),hsl(300 70% 55%),hsl(360 70% 55%))' }}
              />
            </label>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="w-24 shrink-0 text-mist-400">{t('coverflow.picker.own')}</span>
              <button type="button" onClick={() => upload.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 hover:bg-ink-850">
                <Symbol name="upload" className="h-3.5 w-3.5" />
                {t('coverflow.picker.upload')}
              </button>
              <button type="button" onClick={() => setBrowsing((now) => !now)} aria-expanded={browsing} className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 hover:bg-ink-850">
                <Symbol name="clip" className="h-3.5 w-3.5" />
                {t('coverflow.picker.fromVault')}
              </button>
              <input
                ref={upload}
                type="file"
                accept="image/*,.heic,.heif"
                className="hidden"
                data-testid="cover-upload"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  setFocus(50)
                  setChoice({ kind: 'file', file, url: URL.createObjectURL(file) })
                }}
              />
            </div>
            {browsing && (
              <div className="mb-4 rounded-xl border border-ink-700 p-2">
                {pictures === null ? (
                  <p className="p-2 text-sm text-mist-500">{t('common.loading')}</p>
                ) : pictures.length === 0 ? (
                  <p className="p-2 text-sm text-mist-500">{t('coverflow.picker.noPictures')}</p>
                ) : (
                  <div className="grid max-h-48 grid-cols-6 gap-1.5 overflow-y-auto">
                    {pictures.map((path) => (
                      <button
                        key={path}
                        type="button"
                        title={path}
                        aria-pressed={choice.kind === 'vault' && choice.path === path}
                        onClick={() => {
                          setFocus(50)
                          setChoice({ kind: 'vault', path })
                        }}
                        className={tile + chosen(choice.kind === 'vault' && choice.path === path)}
                        style={{ backgroundImage: `url("${fileUrl(path)}")` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            <label className="mb-3 flex items-center gap-3 text-sm text-mist-400">
              <span className="w-24 shrink-0">{t('coverflow.picker.focus')}</span>
              <input type="range" min={0} max={100} value={focus} disabled={!cuts} onChange={(event) => setFocus(Number(event.target.value))} className="flex-1 accent-accent-500 disabled:opacity-40" />
            </label>
            <p className="border-l-2 border-accent-500/50 pl-3 text-xs text-mist-500">{t('coverflow.picker.shape')}</p>
            {problem && <p className="mt-3 text-sm text-bad-500" role="alert">{problem}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-700 px-5 py-3">
          <button type="button" onClick={dismiss} className="rounded-lg border border-ink-700 px-3.5 py-1.5 text-sm hover:bg-ink-850">{t('common.cancel')}</button>
          <button type="button" onClick={() => void save()} disabled={busy} className="rounded-lg bg-accent-500 px-3.5 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50">
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
