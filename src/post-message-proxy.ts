import { isObject } from './is-object';

const MESSAGE_PREFIX = '10ten(ja)';

type Listener = (event: unknown) => void;

export class PostMessageProxy {
  private originalAddEventListener;
  private originalRemoveEventListener;
  private originalOnMessage;
  private listeners: Array<Listener> = [];
  private wrappedListeners: Map<Function, Function> = new Map();

  constructor() {
    // First set up our own listener
    this.onMessage = this.onMessage.bind(this);
    window.addEventListener('message', this.onMessage);

    // Override window.addEventListener
    this.originalAddEventListener = window.addEventListener;
    window.addEventListener = (...args: any[]) => {
      if (args[0] === 'message' && typeof args[1] === 'function') {
        const wrapped = (args[1] = filteredListener(args[1]));
        this.wrappedListeners.set(args[1], wrapped);
      }
      this.originalAddEventListener.apply(window, [].slice.call(args));
    };

    // Override window.removeEventListener too
    this.originalRemoveEventListener = window.removeEventListener;
    window.removeEventListener = (...args: any[]) => {
      if (args[0] === 'message' && typeof args[1] === 'function') {
        const wrapped = this.wrappedListeners.get(args[1]);
        this.wrappedListeners.delete(args[1]);
        args[1] = wrapped || args[1];
      }
      this.originalRemoveEventListener.apply(window, [].slice.call(args));
    };

    // Override window.onmessage
    const originalOnMessage = (this.originalOnMessage =
      Object.getOwnPropertyDescriptor(window, 'onmessage'));
    if (originalOnMessage) {
      const newOnMessage = {
        ...originalOnMessage,
        set: (newValue: unknown) => {
          let valueToSet = newValue;
          if (typeof newValue === 'function') {
            valueToSet = filteredListener(newValue);
          }
          originalOnMessage.set?.(valueToSet);
        },
      };
      Object.defineProperty(window, 'onmessage', newOnMessage);
    }
  }

  detach() {
    window.addEventListener = this.originalAddEventListener;
    window.removeEventListener = this.originalRemoveEventListener;
    if (this.originalOnMessage) {
      Object.defineProperty(window, 'onmessage', this.originalOnMessage);
    }

    window.removeEventListener('message', this.onMessage);

    this.listeners = [];
    this.wrappedListeners = new Map();
  }

  addListener(listener: Listener) {
    if (!this.listeners.includes(listener)) {
      this.listeners.push(listener);
    }
  }

  removeListener(listener: Listener) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  private onMessage(event: MessageEvent) {
    if (isPrefixedEvent(event)) {
      const listeners = this.listeners.slice();
      for (const listener of listeners) {
        listener(event);
      }
    }
  }
}

function filteredListener(listener: Function) {
  return function (event: MessageEvent) {
    if (isPrefixedEvent(event)) {
      return;
    }

    return listener.apply(this, [].slice.call(arguments));
  };
}

function isPrefixedEvent(event: MessageEvent) {
  const kind =
    isObject(event.data) && typeof event.data.kind === 'string'
      ? event.data.kind
      : typeof event.data === 'string'
      ? event.data
      : '';
  return kind.startsWith(MESSAGE_PREFIX);
}
