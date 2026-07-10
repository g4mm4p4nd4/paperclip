import { describe, expect, it } from "vitest";
import {
  detectNoNewSignalReceiptText,
  noNewSignalReceiptTtlMs,
} from "../services/heartbeat.js";

describe("heartbeat no-new-signal receipt policy", () => {
  it("throttles stable maintenance receipts for one hour", () => {
    const receipt = detectNoNewSignalReceiptText(
      "Health is stable and no infrastructure mutation was required.\n\n"
      + "finalDisposition: maintenance; nextActionOwner: null",
    );

    expect(receipt).toMatchObject({
      mode: "final_disposition",
      signals: expect.arrayContaining([
        "final_disposition:maintenance",
        "no_next_action_owner",
      ]),
    });
    expect(noNewSignalReceiptTtlMs(receipt!)).toBe(60 * 60 * 1000);
  });

  it("retains the longer quiet period for explicit no-op handoffs", () => {
    const receipt = detectNoNewSignalReceiptText(
      "No change is required.\n\nfinalDisposition: noop; nextActionOwner: skill_curator",
    );

    expect(receipt).not.toBeNull();
    expect(noNewSignalReceiptTtlMs(receipt!)).toBe(6 * 60 * 60 * 1000);
  });

  it("does not suppress advancing work", () => {
    expect(
      detectNoNewSignalReceiptText(
        "Deployment advanced.\n\nfinalDisposition: advanced_vision; nextActionOwner: null",
      ),
    ).toBeNull();
  });
});
