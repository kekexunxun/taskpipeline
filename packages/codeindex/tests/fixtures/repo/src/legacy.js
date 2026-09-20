'use strict'

const helpers = require('./helpers')
void helpers

function legacyFormat(value) {
  return String(value).trim()
}

class LegacyParser {
  constructor(opts) {
    this.opts = opts || {}
  }
  parse(input) {
    return legacyFormat(input)
  }
}

module.exports = { legacyFormat, LegacyParser }
