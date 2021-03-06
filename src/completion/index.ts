import { Neovim } from '@chemzqm/neovim'
import { CancellationTokenSource, Disposable } from 'vscode-languageserver-protocol'
import events from '../events'
import Document from '../model/document'
import sources from '../sources'
import { CompleteConfig, CompleteOption, ISource, PopupChangeEvent, PumBounding, RecentScore, VimCompleteItem, InsertChange } from '../types'
import { disposeAll, wait } from '../util'
import workspace from '../workspace'
import Complete from './complete'
import Floating from './floating'
import throttle from '../util/throttle'
import { equals } from '../util/object'
import { byteSlice } from '../util/string'
const logger = require('../util/logger')('completion')
const completeItemKeys = ['abbr', 'menu', 'info', 'kind', 'icase', 'dup', 'empty', 'user_data']

export interface LastInsert {
  character: string
  timestamp: number
}

export class Completion implements Disposable {
  public config: CompleteConfig
  private floating: Floating
  private currItem: VimCompleteItem
  // current input string
  private activated = false
  private input: string
  private lastInsert?: LastInsert
  private disposables: Disposable[] = []
  private complete: Complete | null = null
  private recentScores: RecentScore = {}
  private resolveTokenSource: CancellationTokenSource
  private pretext: string
  private changedTick = 0
  private insertCharTs = 0
  private insertLeaveTs = 0

  public init(): void {
    this.config = this.getCompleteConfig()
    this.floating = new Floating()
    events.on('InsertCharPre', this.onInsertCharPre, this, this.disposables)
    events.on('InsertLeave', this.onInsertLeave, this, this.disposables)
    events.on('InsertEnter', this.onInsertEnter, this, this.disposables)
    events.on('TextChangedP', this.onTextChangedP, this, this.disposables)
    events.on('TextChangedI', this.onTextChangedI, this, this.disposables)
    let fn = throttle(this.onPumChange.bind(this), workspace.isVim ? 200 : 100)
    events.on('CompleteDone', async item => {
      this.currItem = null
      this.cancel()
      this.floating.close()
      await this.onCompleteDone(item)
    }, this, this.disposables)
    events.on('MenuPopupChanged', ev => {
      if (!this.activated || this.isCommandLine) return
      let { completed_item } = ev
      let item = completed_item.hasOwnProperty('word') ? completed_item : null
      if (equals(item, this.currItem)) return
      this.cancel()
      this.currItem = item
      fn(ev)
    }, this, this.disposables)
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('suggest')) {
        Object.assign(this.config, this.getCompleteConfig())
      }
    }, null, this.disposables)
  }

  private get nvim(): Neovim {
    return workspace.nvim
  }

  public get option(): CompleteOption {
    if (!this.complete) return null
    return this.complete.option
  }

  private get isCommandLine(): boolean {
    return this.document?.uri.endsWith('%5BCommand%20Line%5D')
  }

  private addRecent(word: string, bufnr: number): void {
    if (!word) return
    this.recentScores[`${bufnr}|${word}`] = Date.now()
  }

  public get isActivated(): boolean {
    return this.activated
  }

  private get document(): Document | null {
    if (!this.option) return null
    return workspace.getDocument(this.option.bufnr)
  }

  private getCompleteConfig(): CompleteConfig {
    let config = workspace.getConfiguration('coc.preferences')
    let suggest = workspace.getConfiguration('suggest')
    function getConfig<T>(key, defaultValue: T): T {
      return config.get<T>(key, suggest.get<T>(key, defaultValue))
    }
    let keepCompleteopt = getConfig<boolean>('keepCompleteopt', false)
    let autoTrigger = getConfig<string>('autoTrigger', 'always')
    if (keepCompleteopt) {
      let { completeOpt } = workspace
      if (!completeOpt.includes('noinsert') && !completeOpt.includes('noselect')) {
        autoTrigger = 'none'
      }
    }
    let acceptSuggestionOnCommitCharacter = workspace.env.pumevent && getConfig<boolean>('acceptSuggestionOnCommitCharacter', false)
    return {
      autoTrigger,
      keepCompleteopt,
      defaultSortMethod: getConfig<string>('defaultSortMethod', 'length'),
      removeDuplicateItems: getConfig<boolean>('removeDuplicateItems', false),
      disableMenuShortcut: getConfig<boolean>('disableMenuShortcut', false),
      acceptSuggestionOnCommitCharacter,
      disableKind: getConfig<boolean>('disableKind', false),
      disableMenu: getConfig<boolean>('disableMenu', false),
      previewIsKeyword: getConfig<string>('previewIsKeyword', '@,48-57,_192-255'),
      enablePreview: getConfig<boolean>('enablePreview', false),
      enablePreselect: getConfig<boolean>('enablePreselect', false),
      maxPreviewWidth: getConfig<number>('maxPreviewWidth', 80),
      labelMaxLength: getConfig<number>('labelMaxLength', 200),
      triggerAfterInsertEnter: getConfig<boolean>('triggerAfterInsertEnter', false),
      noselect: getConfig<boolean>('noselect', true),
      numberSelect: getConfig<boolean>('numberSelect', false),
      maxItemCount: getConfig<number>('maxCompleteItemCount', 50),
      timeout: getConfig<number>('timeout', 500),
      minTriggerInputLength: getConfig<number>('minTriggerInputLength', 1),
      snippetIndicator: getConfig<string>('snippetIndicator', '~'),
      fixInsertedWord: getConfig<boolean>('fixInsertedWord', true),
      localityBonus: getConfig<boolean>('localityBonus', true),
      highPrioritySourceLimit: getConfig<number>('highPrioritySourceLimit', null),
      lowPrioritySourceLimit: getConfig<number>('lowPrioritySourceLimit', null),
      asciiCharactersOnly: getConfig<boolean>('asciiCharactersOnly', false)
    }
  }

  public async startCompletion(option: CompleteOption): Promise<void> {
    this.pretext = byteSlice(option.line, 0, option.colnr - 1)
    try {
      await this._doComplete(option)
    } catch (e) {
      this.stop()
      workspace.showMessage(`Complete error: ${e.message}`, 'error')
      logger.error(e.stack)
    }
  }

  private async resumeCompletion(force = false): Promise<void> {
    let { document, complete } = this
    if (!document
      || complete.isCanceled
      || !complete.results
      || complete.results.length == 0) return
    let search = this.getResumeInput()
    if (search == this.input && !force) return
    if (!search || search.endsWith(' ') || !search.startsWith(complete.input)) {
      this.stop()
      return
    }
    this.input = search
    let items: VimCompleteItem[] = []
    if (complete.isIncomplete) {
      await document.patchChange()
      let { changedtick } = document
      items = await complete.completeInComplete(search)
      if (complete.isCanceled || document.changedtick != changedtick) return
    } else {
      items = complete.filterResults(search)
    }
    if (!complete.isCompleting && items.length === 0) {
      this.stop()
      return
    }
    await this.showCompletion(complete.option.col, items)
  }

  public hasSelected(): boolean {
    if (workspace.env.pumevent) return this.currItem != null
    if (!this.config.noselect) return true
    return false
  }

  private async showCompletion(col: number, items: VimCompleteItem[]): Promise<void> {
    let { nvim, document, option } = this
    let { numberSelect, disableKind, labelMaxLength, disableMenuShortcut, disableMenu } = this.config
    let preselect = this.config.enablePreselect ? items.findIndex(o => o.preselect) : -1
    if (numberSelect && option.input.length && !/^\d/.test(option.input)) {
      items = items.map((item, i) => {
        let idx = i + 1
        if (i < 9) {
          return Object.assign({}, item, {
            abbr: item.abbr ? `${idx} ${item.abbr}` : `${idx} ${item.word}`
          })
        }
        return item
      })
      nvim.call('coc#_map', [], true)
    }
    this.changedTick = document.changedtick
    let validKeys = completeItemKeys.slice()
    if (disableKind) validKeys = validKeys.filter(s => s != 'kind')
    if (disableMenu) validKeys = validKeys.filter(s => s != 'menu')
    let vimItems = items.map(item => {
      let obj = { word: item.word, equal: 1 }
      for (let key of validKeys) {
        if (item.hasOwnProperty(key)) {
          if (disableMenuShortcut && key == 'menu') {
            obj[key] = item[key].replace(/\[.+\]$/, '')
          } else if (key == 'abbr' && item[key].length > labelMaxLength) {
            obj[key] = item[key].slice(0, labelMaxLength)
          } else {
            obj[key] = item[key]
          }
        }
      }
      return obj
    })
    nvim.call('coc#_do_complete', [col, vimItems, preselect], true)
  }

  private async _doComplete(option: CompleteOption): Promise<void> {
    let { source } = option
    let { nvim, config } = this
    let document = workspace.getDocument(option.bufnr)
    if (!document || !document.attached) return
    // use fixed filetype
    option.filetype = document.filetype
    // current input
    this.input = option.input
    let arr: ISource[] = []
    if (source == null) {
      arr = sources.getCompleteSources(option)
    } else {
      let s = sources.getSource(source)
      if (s) arr.push(s)
    }
    if (!arr.length) return
    let complete = new Complete(option, document, this.recentScores, config, arr, nvim)
    this.start(complete)
    await document.patchChange()
    let items = await this.complete.doComplete()
    if (complete.isCanceled) return
    if (items.length == 0 && !complete.isCompleting) {
      this.stop()
      return
    }
    complete.onDidComplete(async () => {
      let search = this.getResumeInput()
      if (complete.isCanceled || search == null) return
      if (this.currItem != null && this.completeOpt.includes('noselect')) return
      let { input } = this.option
      if (search == input) {
        let items = complete.filterResults(search, Math.floor(Date.now() / 1000))
        await this.showCompletion(option.col, items)
      } else {
        await this.resumeCompletion()
      }
    })
    if (items.length) {
      let search = this.getResumeInput()
      if (search == option.input) {
        await this.showCompletion(option.col, items)
      } else {
        await this.resumeCompletion(true)
      }
    }
  }

  private async onTextChangedP(bufnr: number, info: InsertChange): Promise<void> {
    let { option, document } = this
    let pretext = this.pretext = info.pre
    // avoid trigger filter on pumvisible
    if (!option || option.bufnr != bufnr || info.changedtick == this.changedTick) return
    let hasInsert = this.latestInsert != null
    this.lastInsert = null
    if (info.pre.match(/^\s*/)[0] !== option.line.match(/^\s*/)[0]) {
      // Can't handle indent change
      this.stop()
      return
    }
    // not handle when not triggered by character insert
    if (!hasInsert || !pretext) return
    if (sources.shouldTrigger(pretext, document.filetype)) {
      await this.triggerCompletion(document, pretext, false)
    } else {
      await this.resumeCompletion()
    }
  }

  private async onTextChangedI(bufnr: number, info: InsertChange): Promise<void> {
    let { nvim, latestInsertChar, option } = this
    let pretext = this.pretext = info.pre
    this.lastInsert = null
    let document = workspace.getDocument(bufnr)
    if (!document || !document.attached) return
    // try trigger on character type
    if (!this.activated) {
      if (!latestInsertChar) return
      await this.triggerCompletion(document, this.pretext)
      return
    }
    // Ignore change with other buffer
    if (!option || bufnr != option.bufnr) return
    // Check if the change is valid for resume
    if (option.linenr != info.lnum || option.col >= info.col - 1) {
      if (sources.shouldTrigger(pretext, document.filetype)) {
        await this.triggerCompletion(document, pretext, false)
        return
      }
      this.stop()
      return
    }
    // Check commit character
    if (pretext
      && this.currItem
      && this.config.acceptSuggestionOnCommitCharacter
      && latestInsertChar) {
      let resolvedItem = this.getCompleteItem(this.currItem)
      let last = pretext[pretext.length - 1]
      if (sources.shouldCommit(resolvedItem, last)) {
        let { linenr, col, line, colnr } = this.option
        this.stop()
        let { word } = resolvedItem
        let newLine = `${line.slice(0, col)}${word}${latestInsertChar}${line.slice(colnr - 1)}`
        await nvim.call('coc#util#setline', [linenr, newLine])
        let curcol = col + word.length + 2
        await nvim.call('cursor', [linenr, curcol])
        await document.patchChange()
        return
      }
    }
    // prefer trigger completion
    if (sources.shouldTrigger(pretext, document.filetype)) {
      await this.triggerCompletion(document, pretext, false)
    } else {
      await this.resumeCompletion()
    }
  }

  private async triggerCompletion(document: Document, pre: string, checkTrigger = true): Promise<void> {
    if (this.config.autoTrigger == 'none') return
    // check trigger
    if (checkTrigger) {
      let shouldTrigger = await this.shouldTrigger(document, pre)
      if (!shouldTrigger) return
    }
    let option: CompleteOption = await this.nvim.call('coc#util#get_complete_option')
    if (!option) return
    if (pre.length) {
      option.triggerCharacter = pre.slice(-1)
    }
    logger.debug('trigger completion with', option)
    await this.startCompletion(option)
  }

  private async triggerSourceCompletion(doc: Document): Promise<boolean> {
    if (!doc || !doc.attached) return false
    let [bufnr, pre] = await this.nvim.eval(`[bufnr('%'),strpart(getline('.'), 0, col('.') - 1)]`) as [number, string]
    if (doc.bufnr != bufnr || this.complete) return false
    if (sources.shouldTrigger(pre, doc.filetype)) {
      this.triggerCompletion(doc, pre, false).catch(e => {
        logger.error(e)
      })
      return true
    }
    return false
  }

  private async onCompleteDone(item: VimCompleteItem): Promise<void> {
    let { document, isActivated } = this
    if (!isActivated || !document || !item.hasOwnProperty('word')) return
    let opt = Object.assign({}, this.option)
    let resolvedItem = this.getCompleteItem(item)
    this.stop()
    if (!resolvedItem) return
    let timestamp = this.insertCharTs
    let insertLeaveTs = this.insertLeaveTs
    try {
      let visible = await this.nvim.call('pumvisible')
      if (visible) return
      await sources.doCompleteResolve(resolvedItem, (new CancellationTokenSource()).token)
      this.addRecent(resolvedItem.word, document.bufnr)
      // Wait possible TextChangedI
      await wait(50)
      if (this.insertCharTs != timestamp
        || this.insertLeaveTs != insertLeaveTs) return
      await document.patchChange()
      let pre = await this.nvim.eval(`strpart(getline('.'), 0, col('.') - 1)`) as string
      if (!pre.endsWith(resolvedItem.word)) return
      await sources.doCompleteDone(resolvedItem, opt)
    } catch (e) {
      logger.error(`error on complete done`, e.stack)
    }
  }

  private async onInsertLeave(): Promise<void> {
    this.insertLeaveTs = Date.now()
    this.stop()
  }

  private async onInsertEnter(bufnr: number): Promise<void> {
    if (!this.config.triggerAfterInsertEnter || this.config.autoTrigger !== 'always') return
    let doc = workspace.getDocument(bufnr)
    if (!doc || !doc.attached) return
    let pre = await this.nvim.eval(`strpart(getline('.'), 0, col('.') - 1)`) as string
    if (!pre) return
    await this.triggerCompletion(doc, pre)
  }

  private async onInsertCharPre(character: string): Promise<void> {
    this.lastInsert = {
      character,
      timestamp: Date.now(),
    }
    this.insertCharTs = this.lastInsert.timestamp
  }

  private get latestInsert(): LastInsert | null {
    let { lastInsert } = this
    if (!lastInsert || Date.now() - lastInsert.timestamp > 500) {
      return null
    }
    return lastInsert
  }

  private get latestInsertChar(): string {
    let { latestInsert } = this
    if (!latestInsert) return ''
    return latestInsert.character
  }

  public async shouldTrigger(document: Document, pre: string): Promise<boolean> {
    if (pre.length == 0 || /\s/.test(pre[pre.length - 1])) return false
    let autoTrigger = this.config.autoTrigger
    if (autoTrigger == 'none') return false
    if (sources.shouldTrigger(pre, document.filetype)) return true
    if (autoTrigger !== 'always' || this.isActivated) return false
    let last = pre.slice(-1)
    if (last && (document.isWord(pre.slice(-1)) || last.codePointAt(0) > 255)) {
      let minLength = this.config.minTriggerInputLength
      if (minLength == 1) return true
      let input = this.getInput(document, pre)
      return input.length >= minLength
    }
    return false
  }

  public async onPumChange(ev: PopupChangeEvent): Promise<void> {
    if (!this.activated) return
    let { completed_item, col, row, height, width, scrollbar } = ev
    let bounding: PumBounding = { col, row, height, width, scrollbar }
    let resolvedItem = this.getCompleteItem(completed_item)
    if (!resolvedItem) {
      this.floating.close()
      return
    }
    let source = this.resolveTokenSource = new CancellationTokenSource()
    let { token } = source
    await sources.doCompleteResolve(resolvedItem, token)
    if (token.isCancellationRequested) return
    let docs = resolvedItem.documentation
    if (!docs && resolvedItem.info) {
      let { info } = resolvedItem
      let isText = /^[\w-\s.,\t]+$/.test(info)
      docs = [{ filetype: isText ? 'txt' : this.document.filetype, content: info }]
    }
    if (!this.isActivated) return
    if (!docs || docs.length == 0) {
      this.floating.close()
    } else {
      await this.floating.show(docs, bounding, token)
      if (!this.isActivated) {
        this.floating.close()
      }
    }
  }

  public start(complete: Complete): void {
    let { activated } = this
    this.activated = true
    if (activated) {
      this.complete.dispose()
    }
    this.complete = complete
    if (!this.config.keepCompleteopt) {
      this.nvim.command(`noa set completeopt=${this.completeOpt}`, true)
    }
  }

  private cancel(): void {
    if (this.resolveTokenSource) {
      this.resolveTokenSource.cancel()
      this.resolveTokenSource = null
    }
  }

  public stop(): void {
    let { nvim } = this
    if (!this.activated) return
    this.currItem = null
    this.activated = false
    if (this.complete) {
      this.complete.dispose()
      this.complete = null
    }
    nvim.pauseNotification()
    if (this.config.numberSelect) {
      nvim.call('coc#_unmap', [], true)
    }
    if (!this.config.keepCompleteopt) {
      this.nvim.command(`noa set completeopt=${workspace.completeOpt}`, true)
    }
    nvim.command(`let g:coc#_context['candidates'] = []`, true)
    nvim.call('coc#_hide', [], true)
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    nvim.resumeNotification(false, true)
  }

  private getInput(document: Document, pre: string): string {
    let input = ''
    for (let i = pre.length - 1; i >= 0; i--) {
      let ch = i == 0 ? null : pre[i - 1]
      if (!ch || !document.isWord(ch)) {
        input = pre.slice(i, pre.length)
        break
      }
    }
    return input
  }

  public getResumeInput(): string {
    let { option, pretext } = this
    if (!option) return null
    let buf = Buffer.from(pretext, 'utf8')
    if (buf.length < option.col) return null
    let input = buf.slice(option.col).toString('utf8')
    if (option.blacklist && option.blacklist.includes(input)) return null
    return input
  }

  private get completeOpt(): string {
    let { noselect, enablePreview } = this.config
    let preview = enablePreview && !workspace.env.pumevent ? ',preview' : ''
    if (noselect) return `noselect,menuone${preview}`
    return `noinsert,menuone${preview}`
  }

  private getCompleteItem(item: VimCompleteItem): VimCompleteItem | null {
    if (!this.complete || item == null) return null
    return this.complete.resolveCompletionItem(item)
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}

export default new Completion()
