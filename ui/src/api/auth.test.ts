import { afterEach, describe, expect, it, vi } from "vitest";
import { authApi } from "./auth";

describe("authApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the current session without using a cached 304 response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          session: { id: "session-1", userId: "user-1" },
          user: { id: "user-1", email: "board@paperclip.local", name: "Board Admin" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.getSession()).resolves.toMatchObject({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "board@paperclip.local" },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/get-session", {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  });
});
