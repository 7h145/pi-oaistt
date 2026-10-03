/**
 * Purpose: Validate owned literal shortcuts without native action registration.
 * Strategy: Canonicalize keys; localize malformed and native-conflicting bindings.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */
export const ACTIONS = ["dictation.toggle", "dictation.start", "dictation.stop", "editor.correct", "operation.cancel"] as const;
export type Action = typeof ACTIONS[number];
export type Bindings = Record<Action, string[]>;
export const DEFAULT_BINDINGS: Bindings = { "dictation.toggle": ["f8"], "dictation.start": [], "dictation.stop": [], "editor.correct": ["f7"], "operation.cancel": ["f12"] };
export function canonicalKey(key: unknown): string | undefined {
  if (typeof key !== "string" || key.length > 64) return undefined;
  let rest = key.toLowerCase(); const mods: string[] = [];
  for (;;) {
    const match = /^(ctrl|shift|alt|super)\+/u.exec(rest); if (!match) break;
    if (mods.includes(match[1]!)) return undefined;
    mods.push(match[1]!); rest = rest.slice(match[0].length);
  }
  const aliases: Record<string, string> = { esc: "escape", return: "enter" };
  rest = aliases[rest] ?? rest;
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|escape|enter|tab|space|backspace|delete|insert|clear|home|end|pageup|pagedown|up|down|left|right|[`\-=\[\]\\;',./!@#$%^&*()_+|~{}:<>?])$/u.test(rest)) return undefined;
  return [...["ctrl", "alt", "shift", "super"].filter(m => mods.includes(m)), rest].join("+");
}
export function parseBindings(value: unknown): { bindings: Bindings; errors: string[] } {
  const bindings = structuredClone(DEFAULT_BINDINGS), errors: string[] = [];
  if (value !== undefined) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      for (const action of ACTIONS) bindings[action] = [];
      errors.push("Invalid keybindings object; all oaistt keys disabled."); return { bindings, errors };
    }
    let unknown = false;
    for (const [action, raw] of Object.entries(value)) {
      if (!ACTIONS.includes(action as Action)) { if (!unknown) errors.push("Unknown keybindings action(s); ignored."); unknown = true; continue; }
      const values = typeof raw === "string" ? [raw] : raw;
      const keys = Array.isArray(values) && values.length <= 16 ? values.map(canonicalKey) : undefined;
      if (!keys || keys.some(k => k === undefined)) { bindings[action as Action] = []; errors.push(`Invalid keybindings.${action}; disabled.`); }
      else bindings[action as Action] = [...new Set(keys as string[])];
    }
  }
  const usage = new Map<string, Action[]>();
  for (const action of ACTIONS) for (const key of bindings[action]) usage.set(key, [...usage.get(key) ?? [], action]);
  for (const [key, actions] of usage) if (actions.length > 1) {
    for (const action of actions) bindings[action] = bindings[action].filter(k => k !== key);
    errors.push(`Ambiguous oaistt key ${key}; disabled.`);
  }
  return { bindings, errors };
}
export function nativeSafe(bindings: Bindings, native: Record<string, string | string[] | undefined>): { bindings: Bindings; errors: string[] } {
  const blocked = new Set(Object.values(native).flatMap(v => v === undefined ? [] : typeof v === "string" ? [v] : v).map(canonicalKey));
  const result = structuredClone(bindings), errors: string[] = [];
  for (const action of ACTIONS) result[action] = result[action].filter(key => {
    if (!blocked.has(key)) return true;
    errors.push(`keybindings.${action}: ${key} conflicts with a native control; disabled.`); return false;
  });
  return { bindings: result, errors };
}
