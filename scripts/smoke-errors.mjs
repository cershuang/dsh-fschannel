// Unit test for errText.
//
// This exists because errText was once refactored into `return errText(error)`
// — unconditional self-recursion — and shipped. Every catch block in the host
// half became a stack overflow, and nothing caught it: eslint saw a defined,
// used function, and no suite ever exercised an error path. The recursion
// assertion below is the whole point of this file; do not remove it.
import { errText } from '../lib/errors.js'

if (errText(new Error('boom')) !== 'boom') throw new Error('Error -> message')
if (errText(new TypeError('bad type')) !== 'bad type') throw new Error('Error subclass -> message')
if (errText('plain string') !== 'plain string') throw new Error('string passthrough')
if (errText(42) !== '42') throw new Error('number coercion')
if (errText(undefined) !== 'undefined') throw new Error('undefined coercion')
if (errText(null) !== 'null') throw new Error('null coercion')
if (errText({ a: 1 }) !== '[object Object]') throw new Error('object coercion')

// An Error with an empty message must not become "Error" or throw.
if (errText(new Error('')) !== '') throw new Error('empty message stays empty')

// Explicit non-recursion check: a self-recursive implementation blows the stack
// rather than returning, so this both documents and enforces the regression.
try {
  const out = errText(new Error('deep'))
  if (typeof out !== 'string') throw new Error('must return a string')
} catch (error) {
  if (error instanceof RangeError) throw new Error('errText recursed: ' + error.message)
  throw error
}

console.log('ERRORS SMOKE OK (8 cases + non-recursion)')
