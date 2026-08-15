// @ts-check
/**
 * Error-to-text helper, in its own module so it can be unit tested.
 *
 * It lived inside lib/index.js as a module-private function, which is how it
 * survived a refactor that replaced its own body with a call to itself — an
 * unconditional self-recursion that turned every catch block in the host half
 * into a stack overflow. Nothing caught it: `no-undef` sees a defined function,
 * `no-unused-vars` sees a used one, and no suite exercised an error path.
 * @module dsh-fschannel/errors
 */

/**
 * Message text for anything thrown. Not named `msg`: that identifier is a
 * Feishu message parameter throughout the host half and would shadow it.
 * @param {unknown} error - the thrown value.
 * @returns {string} the message of an Error, or the value coerced to a string.
 */
export function errText(error) {
  return error instanceof Error ? error.message : String(error)
}
