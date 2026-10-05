/** Minimal event emitter so core modules stay free of the `vscode` import (and unit-testable). */
export class Emitter<T> {
  private listeners = new Set<(event: T) => void>();

  readonly event = (listener: (event: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty listener must not break the others.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
