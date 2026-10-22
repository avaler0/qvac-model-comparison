/** Each worker promise settles only after its process exits. */
export async function runPanels({ paths, start, cancelled, state, error }) {
  for (const [index, panel] of ['A', 'B'].entries()) {
    if (cancelled()) return 'cancelled';
    state(panel === 'A' ? 'runningA' : 'runningB');
    try { await start(panel, paths[index]); }
    catch (cause) { error(panel, cause); }
    if (cancelled()) return 'cancelled';
    state(panel === 'A' ? 'releasingA' : 'releasingB');
  }
  return 'completed';
}
