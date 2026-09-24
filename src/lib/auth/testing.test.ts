import { describe, expect, it } from "vitest";
import { createTestSecretStore } from "./testing";

describe("createTestSecretStore", () => {
  it("returns null for a key that was never set", async () => {
    const store = createTestSecretStore();
    expect(await store.get("missing")).toBeNull();
  });

  it("round-trips: set -> get -> overwrite -> get -> delete -> get", async () => {
    const store = createTestSecretStore();

    await store.set("refresh_token", "abc");
    expect(await store.get("refresh_token")).toBe("abc");

    await store.set("refresh_token", "def");
    expect(await store.get("refresh_token")).toBe("def");

    await store.delete("refresh_token");
    expect(await store.get("refresh_token")).toBeNull();
  });

  it("deleting an absent key is a no-op, not an error", async () => {
    const store = createTestSecretStore();
    await expect(store.delete("never-set")).resolves.toBeUndefined();
  });

  it("keeps keys independent", async () => {
    const store = createTestSecretStore();
    await store.set("a", "1");
    await store.set("b", "2");
    expect(await store.get("a")).toBe("1");
    expect(await store.get("b")).toBe("2");
  });

  it("returns a fresh, independent store per call", async () => {
    const a = createTestSecretStore();
    const b = createTestSecretStore();
    await a.set("k", "v");
    expect(await b.get("k")).toBeNull();
  });
});
