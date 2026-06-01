import { describe, expect, it } from "vitest";
import { isClientIpAllowed } from "../middleware/private-client-ip-guard.js";

describe("privateClientIpGuard", () => {
  it("always allows loopback for local cockpit health checks", () => {
    expect(isClientIpAllowed("127.0.0.1", ["192.168.50.77"])).toBe(true);
    expect(isClientIpAllowed("::ffff:127.0.0.1", ["192.168.50.77"])).toBe(true);
    expect(isClientIpAllowed("::1", ["192.168.50.77"])).toBe(true);
  });

  it("allows explicitly configured client IPs", () => {
    expect(isClientIpAllowed("192.168.50.77", ["192.168.50.77"])).toBe(true);
  });

  it("blocks other LAN clients when an allowlist is configured", () => {
    expect(isClientIpAllowed("192.168.50.88", ["192.168.50.77"])).toBe(false);
  });

  it("supports IPv4 CIDR allowlist entries", () => {
    expect(isClientIpAllowed("192.168.50.77", ["192.168.50.0/24"])).toBe(true);
    expect(isClientIpAllowed("192.168.51.77", ["192.168.50.0/24"])).toBe(false);
  });
});
