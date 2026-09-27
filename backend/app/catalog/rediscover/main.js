/* Rediscover: what was written a year ago today, and a random note that was not touched for a while. */
(function () {
  'use strict'

  function yearAgo() {
    var when = new Date()
    when.setFullYear(when.getFullYear() - 1)
    var pad = function (value) { return (value < 10 ? '0' : '') + value }
    return when.getFullYear() + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate())
  }

  function section(title) {
    var box = document.createElement('div')
    var heading = document.createElement('p')
    heading.className = 'muted small'
    heading.textContent = title
    var list = document.createElement('ul')
    list.className = 'plain'
    box.appendChild(heading)
    box.appendChild(list)
    document.getElementById('app').appendChild(box)
    return list
  }

  function fill(list, notes) {
    list.textContent = ''
    if (!notes.length) {
      var none = document.createElement('li')
      none.className = 'muted'
      none.textContent = nexlore.t('nothing')
      list.appendChild(none)
      return
    }
    notes.forEach(function (note) {
      var item = document.createElement('li')
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'link'
      button.textContent = note.title
      button.addEventListener('click', function () { nexlore.ask('note.open', { path: note.path }).catch(function () {}) })
      item.appendChild(button)
      list.appendChild(item)
    })
  }

  nexlore.ready(function () {
    var past = section(nexlore.t('yearAgo'))
    var random = section(nexlore.t('random'))
    var again = document.createElement('button')
    again.type = 'button'
    again.className = 'pill'
    again.textContent = nexlore.t('another')
    document.getElementById('app').appendChild(again)
    var pick = function () {
      nexlore.ask('vault.query', { random: true, limit: 1 }).then(function (notes) { fill(random, notes) }, function () {})
    }
    again.addEventListener('click', pick)
    nexlore.ask('vault.query', { day: yearAgo(), limit: 5 }).then(function (notes) { fill(past, notes) }, function () {})
    pick()
  })
})()
