/**
 * pi-oaistt extension entry point
 *
 * Purpose: expose the dictation extension to Pi directory/package loading.
 * Strategy: re-export the public extension factory without starting work.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

export { default } from "./src/extension.ts";
