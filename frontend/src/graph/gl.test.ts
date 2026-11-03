import { describe, expect, it } from 'vitest'

import { SHADERS } from './gl'

/** Each float uniform of a shader with its precision: the one it names, else the shader's default for floats. */
function floatUniforms(source: string, fallback: string): Map<string, string> {
  const given = /precision\s+(lowp|mediump|highp)\s+float\s*;/.exec(source)?.[1] ?? fallback
  const found = new Map<string, string>()
  for (const [, precision, type, names] of source.matchAll(/uniform\s+(?:(lowp|mediump|highp)\s+)?(\w+)\s+([^;]+);/g)) {
    if (!/^(float|vec[234]|mat[234])$/.test(type)) continue
    for (const name of names.split(',')) found.set(name.trim(), precision ?? given)
  }
  return found
}

describe('the shaders', () => {
  // Firefox refuses to link a program whose two shaders give a shared uniform different precisions; Chrome draws it
  // anyway (issue #16: no map in Firefox at all).
  it('give a uniform both of their shaders declare the same precision in each', () => {
    for (const [program, [vertex, fragment]] of Object.entries(SHADERS)) {
      const inVertex = floatUniforms(vertex, 'highp')
      const inFragment = floatUniforms(fragment, 'none')
      expect(inVertex.size, program).toBeGreaterThan(0)
      for (const [name, precision] of inFragment) {
        if (inVertex.has(name)) expect(`${program} ${name} ${precision}`).toBe(`${program} ${name} ${inVertex.get(name)}`)
      }
    }
  })
})
