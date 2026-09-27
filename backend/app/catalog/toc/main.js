/* Contents: the headings of the note, its words and its reading time. Reads the note, changes nothing. */
(function () {
  'use strict'
  var WORDS_PER_MINUTE = 200

  function parse(text) {
    var lines = text.replace(/\r\n?/g, '\n').split('\n')
    var start = 0
    if (lines[0] === '---') {
      for (var i = 1; i < lines.length; i++) {
        if (lines[i] === '---' || lines[i] === '...') { start = i + 1; break }
      }
    }
    var headings = []
    var fence = null
    var words = 0
    for (var j = start; j < lines.length; j++) {
      var line = lines[j]
      var opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (fence) {
        if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = null
        continue
      }
      if (opening) { fence = opening[1]; continue }
      var heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
      if (heading && heading[2]) headings.push({ level: heading[1].length, text: heading[2].replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2') })
      var found = line.match(/[^\s#>*\-|`]+/g)
      if (found) words += found.length
    }
    return { headings: headings, words: words }
  }

  function render(note) {
    var root = document.getElementById('app')
    root.textContent = ''
    var facts = parse(note.content)
    var meta = document.createElement('p')
    meta.className = 'muted small'
    var minutes = Math.max(1, Math.round(facts.words / WORDS_PER_MINUTE))
    meta.textContent = nexlore.t('words', { count: facts.words }) + ' · ' + nexlore.t('minutes', { count: minutes })
    root.appendChild(meta)
    if (!facts.headings.length) {
      var none = document.createElement('p')
      none.className = 'muted'
      none.textContent = nexlore.t('none')
      root.appendChild(none)
      return
    }
    var top = Math.min.apply(null, facts.headings.map(function (h) { return h.level }))
    var list = document.createElement('ul')
    list.className = 'plain'
    facts.headings.forEach(function (heading, index) {
      var item = document.createElement('li')
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'link'
      button.style.paddingLeft = (heading.level - top) * 12 + 'px'
      button.textContent = heading.text
      button.addEventListener('click', function () {
        nexlore.ask('note.reveal', { heading: heading.text, index: index }).catch(function () {})
      })
      item.appendChild(button)
      list.appendChild(item)
    })
    root.appendChild(list)
  }

  function load() {
    nexlore.ask('note.read').then(render, function () {})
  }

  nexlore.ready(load)
  nexlore.on('changed', load)
})()
