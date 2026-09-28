/** Which bubble names win where they would overlap. */
import { closedLabelPriority } from './labels'

describe('names of closed bubbles', () => {
  it('put bigger bubbles first', () => {
    expect(closedLabelPriority(400, 0)).toBeGreaterThan(closedLabelPriority(80, 0))
  })

  it('let a bubble that is opening give way to every closed bubble inside it', () => {
    // A space seen whole but starting to open: its fading name must not hide the names of its folders.
    expect(closedLabelPriority(2000, 0.3)).toBeLessThan(closedLabelPriority(20, 0))
    expect(closedLabelPriority(2000, 0.01)).toBeGreaterThan(closedLabelPriority(20, 0))
  })
})
