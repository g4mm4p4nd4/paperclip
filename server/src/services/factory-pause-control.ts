export interface FactoryPauseControl {
  isPaused(): boolean;
  pause(): Promise<void>;
}

export function createFactoryPauseControl(input: {
  initiallyPaused: boolean;
  persistPause: () => void | Promise<void>;
}): FactoryPauseControl {
  let paused = input.initiallyPaused;
  let inFlight: Promise<void> | null = null;
  return {
    isPaused: () => paused,
    async pause() {
      if (paused) return;
      if (!inFlight) {
        inFlight = Promise.resolve(input.persistPause()).then(() => { paused = true; }).finally(() => { inFlight = null; });
      }
      await inFlight;
    },
  };
}
