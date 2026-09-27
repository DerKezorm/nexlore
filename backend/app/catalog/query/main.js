/*
 * Queries: a code block ```query``` with lines like
 *
 *   tag: garden
 *   folder: Projects/Garden
 *   space: Work
 *   sort: modified | title
 *   limit: 20
 *   view: list | table
 *
 * shows the notes that match, as a list or a table. Only what the account may read; nothing is ever run.
 */
(function () {
  'use strict'
  var KEYS = ['tag', 'folder', 'space', 'sort', 'limit', 'view']

  function parse(source) {
    var query = { view: 'list' }
    var problems = []
    String(source || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim()
      if (!line || line.charAt(0) === '#') return
      var match = /^([a-z]+)\s*:\s*(.*)$/i.exec(line)
      if (!match || KEYS.indexOf(match[1].toLowerCase()) < 0) { problems.push(line); return }
      query[match[1].toLowerCase()] = match[2].trim()
    })
    if (query.tag) query.tag = query.tag.replace(/^#/, '')
    if (query.limit) query.limit = Math.max(1, Math.min(200, parseInt(query.limit, 10) || 20))
    return { query: query, problems: problems }
  }

  function day(ms) {
    return new Date(ms).toLocaleDateString(document.documentElement.lang || 'en')
  }

  function openButton(note) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'link'
    button.textContent = note.title
    button.addEventListener('click', function () { nexlore.ask('note.open', { path: note.path }).catch(function () {}) })
    return button
  }

  function folderOf(path) {
    var parts = path.split('/')
    return parts.slice(0, -1).join('/')
  }

  function render(parsed, notes) {
    var root = document.getElementById('app')
    root.textContent = ''
    parsed.problems.forEach(function (line) {
      var problem = document.createElement('p')
      problem.className = 'warn small'
      problem.textContent = nexlore.t('unknown', { line: line })
      root.appendChild(problem)
    })
    if (!notes.length) {
      var none = document.createElement('p')
      none.className = 'muted'
      none.textContent = nexlore.t('nothing')
      root.appendChild(none)
      return
    }
    if (parsed.query.view === 'table') {
      var table = document.createElement('table')
      var head = document.createElement('tr')
      ;['note', 'folder', 'changed'].forEach(function (key) {
        var cell = document.createElement('th')
        cell.textContent = nexlore.t(key)
        head.appendChild(cell)
      })
      table.appendChild(head)
      notes.forEach(function (note) {
        var row = document.createElement('tr')
        var name = document.createElement('td')
        name.appendChild(openButton(note))
        var folder = document.createElement('td')
        folder.className = 'muted'
        folder.textContent = folderOf(note.path)
        var changed = document.createElement('td')
        changed.className = 'muted'
        changed.textContent = day(note.modified)
        row.appendChild(name)
        row.appendChild(folder)
        row.appendChild(changed)
        table.appendChild(row)
      })
      root.appendChild(table)
      return
    }
    var list = document.createElement('ul')
    notes.forEach(function (note) {
      var item = document.createElement('li')
      item.appendChild(openButton(note))
      list.appendChild(item)
    })
    root.appendChild(list)
  }

  function run(context) {
    var parsed = parse(context.source)
    nexlore.ask('vault.query', parsed.query).then(
      function (notes) { render(parsed, notes) },
      function () {
        var root = document.getElementById('app')
        root.textContent = nexlore.t('failed')
      }
    )
  }

  nexlore.ready(run)
})()
