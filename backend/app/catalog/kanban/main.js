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
 * lanes (the archive after ***, the plugin's settings in %% kanban:settings %%) stays as it is. Ticking off a card
 * changes only its line. Moving or adding one writes the lanes it touches the way the Obsidian Kanban plugin writes
 * every lane (its laneToMd): the heading, one blank line, the cards, two blank lines before the next lane, three
 * under an empty one. A board the plugin wrote changes in the card's lines alone; lanes not touched stay as they are.
 * The note is written against the state it was read in, so a change made meanwhile ends in a conflict copy, never
 * lost.
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
        if (lane) lane.next = i
        lane = { title: heading[1].trim(), heading: i, cards: [], end: i + 1, next: lines.length }
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
    if (lane) lane.next = i
    return { lines: lines, eol: eol, lanes: lanes }
  }

  /* What a lane holds between its heading and the next lane, blank lines left out; `skip` is a card taken out. */
  function body(state, lane, skip) {
    var kept = []
    for (var i = lane.heading + 1; i < lane.next; i++) {
      if (skip && i >= skip.start && i < skip.end) continue
      if (state.lines[i].trim()) kept.push(state.lines[i])
    }
    return kept
  }

  /* The lane's body with `cards` put after its last card, or at its top (below the plugin's **Complete**). */
  function withCards(state, lane, cards) {
    var kept = body(state, lane)
    var last = lane.cards.length ? lane.cards[lane.cards.length - 1] : null
    var at = 0
    if (last) at = body(state, { heading: lane.heading, next: last.end }).length
    else if (kept.length && /^\*\*Complete\*\*$/.test(kept[0].trim())) at = 1
    return kept.slice(0, at).concat(cards, kept.slice(at))
  }

  /* The note with the lanes in `bodies` (by number) written as the Kanban plugin writes a lane. */
  function rebuild(state, bodies) {
    var lines = state.lines
    var out = lines.slice(0, state.lanes[0].heading)
    state.lanes.forEach(function (lane, index) {
      if (!(index in bodies)) {
        out = out.concat(lines.slice(lane.heading, lane.next))
        return
      }
      // Before the next lane: two blank lines. Before the archive, the settings or the end of the file: the blank
      // lines that were there (the plugin writes those as part of what follows).
      var tail = ['', '']
      if (lane.next >= lines.length || !/^##\s+/.test(lines[lane.next])) {
        tail = []
        for (var i = lane.next - 1; i > lane.heading && !lines[i].trim(); i--) tail.push('')
      }
      out = out.concat([lines[lane.heading], ''], bodies[index], tail)
    })
    return out.concat(lines.slice(state.lanes[state.lanes.length - 1].next))
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
    var bodies = {}
    bodies[from] = body(state, state.lanes[from], card)
    bodies[to] = withCards(state, state.lanes[to], state.lines.slice(card.start, card.end))
    write(rebuild(state, bodies), state.eol)
  }

  function add(state, to, text) {
    var bodies = {}
    bodies[to] = withCards(state, state.lanes[to], ['- [ ] ' + text.replace(/[\r\n]+/g, ' ')])
    write(rebuild(state, bodies), state.eol)
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
