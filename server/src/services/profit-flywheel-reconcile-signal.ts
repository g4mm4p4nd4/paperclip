import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(4);

/**
 * Completion is the normal trigger for Profit Flywheel reconciliation. The
 * durable database remains authoritative; this signal is deliberately only a
 * low-latency hint, so a process crash cannot lose work.
 */
export function notifyProfitFlywheelReconciliation() {
  emitter.emit("reconcile");
}

export function subscribeProfitFlywheelReconciliation(listener: () => void) {
  emitter.on("reconcile", listener);
  return () => emitter.off("reconcile", listener);
}
