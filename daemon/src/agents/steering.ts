/**
 * M7 voice steering: append the user's queued mid-task guidance to the NEXT tool result —
 * every tool result is already a model attention point, so this injects steering into a
 * RUNNING agents-SDK loop with no SDK surgery (the same seam the structured stall note
 * rides). Wrapped over the tool's `invoke`, the exact surface the SDK runner calls (and
 * the same one the unit tests drive, so the patch point is pinned by the suite).
 */
export function wrapSteering<T extends { invoke: (ctx: unknown, input: string) => Promise<unknown> }>(
  toolObj: T,
  takeSteering: () => string[],
): T {
  const original = toolObj.invoke.bind(toolObj);
  toolObj.invoke = async (ctx: unknown, input: string) => {
    const out = await original(ctx, input);
    const msgs = takeSteering();
    if (msgs.length === 0 || typeof out !== 'string') return out;
    // Steering is THE USER's voice — the one instruction source that outranks screen text.
    return (
      out +
      '\n\n' +
      msgs.map((m) => `STEERING FROM THE USER (spoken mid-task — follow it): ${m}`).join('\n')
    );
  };
  return toolObj;
}
