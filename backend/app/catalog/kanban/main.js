/*
 * Kanban: a note in the format of the Obsidian Kanban plugin as a board.
 *
 *   ---
 *   kanban-plugin: basic
 *   ---
 *   ## Lane
 *   - [ ] a card
 *
 * A lane is a heading ##, a card a list item below it (with the lines indented under it). Everything after the
 * lanes (the archive after ***, the plugin's settings in %% kanban:settings %%) stays as it is. Moving, adding or
 * ticking off a card changes only that card's lines; the note is written against the state it was read in, so a
 * change made meanwhile ends in a conflict copy, never lost.
 */
(function () {
  'use strict'
  var note = null
  var busy = false

  function board(content) {
    var eol = content.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
    var lines = content.split(/\r?\n/)
    var lanes = []
    var i = 0
    if (lines[0] === '---') {
      for (i = 1; i < lines.length && lines[i] !== '---'; i++);
      i++
    }
    var lane = null
    for (; i < lines.length; i++) {
      var line = lines[i]
      if (/^\*\*\*\s*$/.test(line) || /^%%\s*kanban:settings/.test(line)) break
      var heading = /^##\s+(.*)$/.exec(line)
      if (heading) {
        lane = { title: heading[1].trim(), heading: i, cards: [], end: i + 1 }
        lanes.push(lane)
        continue
      }
      if (!lane) continue
      var card = /^[-*+]\s+(?:\[(.)\]\s+)?(.*)$/.exec(line)
      if (card) {
        var start = i
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i++
        lane.cards.push({ start: start, end: i + 1, text: card[2], done: card[1] !== undefined && card[1] !== ' ', mark: card[1] })
        lane.end = i + 1
      } else if (line.trim() && !/^\*\*Complete\*\*$/.test(line.trim())) {
        lane.end = i + 1
      }
    }
    return { lines: lines, eol: eol, lanes: lanes }
  }

  function write(lines, eol) {
    if (busy) return
    busy = true
    var content = lines.join(eol)
    nexlore.ask('note.write', { content: content, base_hash: note.hash }).then(
      function (answer) {
        busy = false
        if (answer.conflict) notice(nexlore.t('conflict'))
        load()
      },
      function () {
        busy = false
        notice(nexlore.t('failed'))
      }
    )
  }

  function notice(text) {
    var box = document.getElementById('notice')
    box.textContent = text
    box.hidden = !text
  }

  function move(state, from, index, to) {
    var card = state.lanes[from].cards[index]
    var target = state.lanes[to]
    var taken = state.lines.slice(card.start, card.end)
    var lines = state.lines.slice()
    // Where it goes: after the last card of the lane, or right under its heading (after one blank line).
    var at = target.cards.length ? target.cards[target.cards.length - 1].end : target.heading + 1
    if (!target.cards.length && lines[at] === '') at++
    if (at > card.start) at -= taken.length
    lines.splice(card.start, taken.length)
    Array.prototype.splice.apply(lines, [at, 0].concat(taken))
    write(lines, state.eol)
  }

  function add(state, to, text) {
    var target = state.lanes[to]
    var lines = state.lines.slice()
    var at = target.cards.length ? target.cards[target.cards.length - 1].end : target.heading + 1
    if (!target.cards.length && lines[at] === '') at++
    lines.splice(at, 0, '- [ ] ' + text.replace(/[\r\n]+/g, ' '))
    write(lines, state.eol)
  }

  function tick(state, from, index) {
    var card = state.lanes[from].cards[index]
    var lines = state.lines.slice()
    lines[card.start] = lines[card.start].replace(/^([-*+]\s+)\[(.)\]/, function (_all, bullet, mark) {
      return bullet + (mark === ' ' ? '[x]' : '[ ]')
    })
    if (lines[card.start] === state.lines[card.start]) lines[card.start] = lines[card.start].replace(/^([-*+]\s+)/, '$1[x] ')
    write(lines, state.eol)
  }

  function render() {
    var state = board(note.content)
    var root = document.getElementById('board')
    root.textContent = ''
    if (!state.lanes.length) {
      var empty = document.createElement('p')
      empty.className = 'muted'
      empty.textContent = nexlore.t('empty')
      root.appendChild(empty)
      return
    }
    state.lanes.forEach(function (lane, laneIndex) {
      var column = document.createElement('section')
      column.className = 'lane'
      column.addEventListener('dragover', function (event) { event.preventDefault() })
      column.addEventListener('drop', function (event) {
        event.preventDefault()
        var data = String(event.dataTransfer.getData('text/plain')).split(':')
        var from = Number(data[0])
        var index = Number(data[1])
        if (data.length === 2 && from !== laneIndex && state.lanes[from]) move(state, from, index, laneIndex)
      })
      var title = document.createElement('h3')
      title.textContent = lane.title + ' '
      var count = document.createElement('span')
      count.className = 'muted small'
      count.textContent = String(lane.cards.length)
      title.appendChild(count)
      column.appendChild(title)
      var list = document.createElement('ul')
      list.className = 'plain cards'
      lane.cards.forEach(function (card, cardIndex) {
        var item = document.createElement('li')
        item.className = 'card' + (card.done ? ' done' : '')
        item.draggable = true
        item.addEventListener('dragstart', function (event) {
          event.dataTransfer.setData('text/plain', laneIndex + ':' + cardIndex)
        })
        var box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = card.done
        box.setAttribute('aria-label', nexlore.t('done'))
        box.addEventListener('change', function () { tick(state, laneIndex, cardIndex) })
        var text = document.createElement('span')
        text.textContent = card.text.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
        item.appendChild(box)
        item.appendChild(text)
        var moves = document.createElement('span')
        moves.className = 'moves'
        ;[[-1, '◀', 'left'], [1, '▶', 'right']].forEach(function (step) {
          var target = laneIndex + step[0]
          if (target < 0 || target >= state.lanes.length) return
          var button = document.createElement('button')
          button.type = 'button'
          button.textContent = step[1]
          button.setAttribute('aria-label', nexlore.t(step[2]))
          button.addEventListener('click', function () { move(state, laneIndex, cardIndex, target) })
          moves.appendChild(button)
        })
        item.appendChild(moves)
        list.appendChild(item)
      })
      column.appendChild(list)
      var form = document.createElement('form')
      var input = document.createElement('input')
      input.placeholder = '+ ' + nexlore.t('add')
      input.setAttribute('aria-label', nexlore.t('add') + ': ' + lane.title)
      form.appendChild(input)
      form.addEventListener('submit', function (event) {
        event.preventDefault()
        if (input.value.trim()) add(state, laneIndex, input.value.trim())
      })
      column.appendChild(form)
      root.appendChild(column)
    })
  }

  function load() {
    nexlore.ask('note.read').then(function (found) {
      note = found
      render()
    }, function () {})
  }

  nexlore.ready(function () {
    var root = document.getElementById('app')
    var box = document.createElement('p')
    box.id = 'notice'
    box.className = 'warn small'
    box.hidden = true
    root.appendChild(box)
    var area = document.createElement('div')
    area.id = 'board'
    area.className = 'board'
    root.appendChild(area)
    load()
  })
  nexlore.on('changed', load)
})()
