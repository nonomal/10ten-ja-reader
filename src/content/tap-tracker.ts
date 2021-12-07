type IsTapCallback = (isTap: boolean) => void;

type TapState =
  | { kind: 'idle' }
  | {
      kind: 'mousedown';
      timeout: ReturnType<typeof setTimeout>;
      cb?: IsTapCallback;
    }
  | { kind: 'longpress' };

// A little utility function to track mouseup/down events so we can distinguish
// between a tap and long-press.
//
// The caller notifies on each mouseDown / mouseUp event.
//
// Along with each call to `mouseDown`, the caller may pass a callback that
// will be called once with a flag indicating if the mousedown resulted in a
// tap (true) or a long-press (false).
export class TapTracker {
  private tapState: TapState = { kind: 'idle' };

  mouseDown(cb?: (isTap: boolean) => void) {
    // This shouldn't happen, but if it does, make sure we clean up.
    if (this.tapState.kind === 'mousedown') {
      clearTimeout(this.tapState.timeout);
      this.tapState.cb?.(true);
    }

    const timeout = setTimeout(() => {
      this.tapState = { kind: 'longpress' };
      cb?.(false);
    }, 100);

    this.tapState = { kind: 'mousedown', timeout, cb };
  }

  mouseUp() {
    if (this.tapState.kind === 'mousedown') {
      clearTimeout(this.tapState.timeout);
      this.tapState.cb?.(true);
    }
    this.tapState = { kind: 'idle' };
  }
}
