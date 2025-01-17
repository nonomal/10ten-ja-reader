export class TouchClickTracker {
  private wasTouch = false;
  private ignoring = false;
  onTouchClick?: (event: MouseEvent) => void;

  constructor() {
    this.onTouchStart = this.onTouchStart.bind(this);
    this.onTouchEnd = this.onTouchEnd.bind(this);
    this.onClick = this.onClick.bind(this);

    window.addEventListener('touchstart', this.onTouchStart, { passive: true });
    window.addEventListener('touchend', this.onTouchEnd, { passive: true });
    // We need to register for clicks on the _body_ because if there is no
    // click handler on the body element, iOS won't generate click events
    // from touch taps.
    document.body?.addEventListener('click', this.onClick);
  }

  destroy() {
    window.removeEventListener('touchstart', this.onTouchStart);
    window.removeEventListener('touchend', this.onTouchEnd);
    document.body?.removeEventListener('click', this.onClick);
  }

  startIgnoringClicks() {
    this.ignoring = true;
  }

  stopIgnoringClicks() {
    this.ignoring = false;
  }

  private onTouchStart() {
    this.wasTouch = false;
  }

  private onTouchEnd() {
    this.wasTouch = !this.ignoring;
  }

  private onClick(event: MouseEvent) {
    const { wasTouch } = this;
    this.wasTouch = false;
    if (wasTouch) {
      this.onTouchClick?.(event);
    }
  }
}
