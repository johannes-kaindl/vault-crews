// Tests des JSON-Transports. Der Streaming-Transport (XHR) und der requestUrl-Fallback kommen seit
// Welle 11 aus dem Kit (`chat-transport`) und sind dort getestet.
// requestUrl kommt als Spy aus dem vendorten Obsidian-Mock (gleiche Datei wie der
// vitest-Alias `obsidian` → modul-identisch mit dem Import in transports.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "../__mocks__/obsidian";
import { RequestUrlJsonTransport } from "../../src/obsidian/transports";

afterEach(() => { vi.unstubAllGlobals(); });

describe("RequestUrlJsonTransport", () => {
  it("getJson ruft requestUrl mit throw:false und parst den Text-Body", async () => {
    requestUrl.mockClear();
    requestUrl.mockResolvedValue({ status: 200, text: '{"data":[{"id":"m1"}]}', headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0) });
    const t = new RequestUrlJsonTransport();
    expect(await t.getJson("http://localhost:1234/v1/models")).toEqual({ data: [{ id: "m1" }] });
    expect(requestUrl.mock.calls[0]?.[0]).toMatchObject({
      url: "http://localhost:1234/v1/models",
      method: "GET",
      throw: false,
    });
  });

  it("postJson sendet JSON-Body mit throw:false und liefert null bei Nicht-JSON-Antwort", async () => {
    requestUrl.mockClear();
    requestUrl.mockResolvedValue({ status: 500, text: "Internal Server Error", headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0) });
    const t = new RequestUrlJsonTransport();
    expect(await t.postJson("http://localhost:1234/v1/chat/completions", { model: "m" })).toBeNull();
    expect(requestUrl.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      throw: false,
      body: '{"model":"m"}',
      headers: { "Content-Type": "application/json" },
    });
  });
});
