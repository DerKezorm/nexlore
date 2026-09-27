/*
 * The plugin side of nexlore's plugin API, placed in front of every plugin's code inside its frame.
 *
 * A plugin runs in a sandboxed frame of its own origin (none: "null"), without cookies, without network (the frame's
 * policy allows no connection, no picture, no font from anywhere) and without a way to navigate the app. All it can
 * do is ask the app, through postMessage, for what its manifest says it may: the app checks every request.
 *
 *   nexlore.ready((context) => ...)   context: { place, path, language, strings, theme, source }
 *   nexlore.ask('note.read')          a promise of the answer; refused requests reject
 *   nexlore.on('changed', fn)         the app says the note changed
 *   nexlore.t('key', { count: 2 })    the plugin's own strings in the account's language
 *   nexlore.resize()                  the frame follows the height of the page (also done by itself)
 */
(function () {
  'use strict'
  var sequence = 0
  var waiting = {}
  var handlers = {}
  var context = null
  var readyCallbacks = []

  function post(message) {
    message.nx = 1
    window.parent.postMessage(message, '*')
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return
    var message = event.data
    if (!message || message.nx !== 1) return
    if (message.reply) {
      var entry = waiting[message.reply]
      if (!entry) return
      delete waiting[message.reply]
      if (message.error) entry.reject(new Error(message.error))
      else entry.resolve(message.value)
      return
    }
    if (message.event === 'init') {
      context = message.value
      document.documentElement.lang = context.language || 'en'
      applyTheme(context.theme || {})
      var callbacks = readyCallbacks
      readyCallbacks = []
      callbacks.forEach(function (callback) { callback(context) })
      resize()
      return
    }
    if (message.event === 'theme') applyTheme(message.value || {})
    ;(handlers[message.event] || []).forEach(function (handler) { handler(message.value) })
  })

  function applyTheme(theme) {
    var root = document.documentElement.style
    Object.keys(theme).forEach(function (name) {
      if (/^--[a-z0-9-]+$/.test(name)) root.setProperty(name, String(theme[name]))
    })
  }

  function resize() {
    var height = Math.ceil(document.documentElement.scrollHeight)
    post({ method: 'resize', args: { height: height } })
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () { resize() }).observe(document.documentElement)
  }

  function interpolate(text, values) {
    return String(text).replace(/\{\{(\w+)\}\}/g, function (_match, name) {
      return values && values[name] !== undefined ? String(values[name]) : ''
    })
  }

  window.nexlore = {
    ready: function (callback) {
      if (context) callback(context)
      else readyCallbacks.push(callback)
    },
    ask: function (method, args) {
      return new Promise(function (resolve, reject) {
        var id = ++sequence
        waiting[id] = { resolve: resolve, reject: reject }
        post({ id: id, method: method, args: args || {} })
      })
    },
    on: function (name, handler) {
      ;(handlers[name] = handlers[name] || []).push(handler)
    },
    t: function (key, values) {
      var strings = (context && context.strings) || {}
      var text = strings[key]
      if (values && typeof values.count === 'number') {
        text = strings[key + (values.count === 1 ? '_one' : '_other')] || text
      }
      return interpolate(text === undefined ? key : text, values)
    },
    resize: resize,
  }
})()
