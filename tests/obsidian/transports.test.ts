// Smoke-Tests der Transports. XhrSseTransport wird gegen einen injizierten Fake-XHR
// getestet (vault-rag-Muster): der Test steuert onprogress/onload/onerror von außen.
// requestUrl kommt als Spy aus dem vendorten Obsidian-Mock (gleiche Datei wie der
// vitest-Alias `obsidian` → modul-identisch mit dem Import in transports.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "../__mocks__/obsidian";
import { RequestUrlJsonTransport, XhrSseTransport } from "../../src/obsidian/transports";

class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  body = "";
  headers: Record<string, string> = {};
  status = 0;
  responseText = "";
  aborted = false;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string): void { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string): void { this.headers[k] = v; }
  send(body: string): void { this.body = body; FakeXhr.instances.push(this); }
  abort(): void { this.aborted = true; this.onabort?.(); }
  // Test-Affordanzen:
  push(chunk: string): void { this.responseText += chunk; this.onprogress?.(); }
  finish(status: number): void { this.status = status; this.onload?.(); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.instances = [];
});

describe("XhrSseTransport", () => {
  it("liefert onChunk nur die neuen Roh-Deltas (lastIndex) und resolved mit dem HTTP-Status", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const chunks: string[] = [];
    const p = new XhrSseTransport().postStream(
      "http://localhost:1234/v1/chat/completions",
      { model: "m" },
      (raw) => chunks.push(raw),
      new AbortController().signal,
    );
    const xhr = FakeXhr.instances[0]!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("http://localhost:1234/v1/chat/completions");
    expect(xhr.headers["Content-Type"]).toBe("application/json");
    expect(xhr.body).toBe('{"model":"m"}');

    xhr.push('data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n');
    xhr.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
    xhr.finish(200);

    expect(await p).toBe(200);
    expect(chunks).toEqual([
      'data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
    ]);
  });

  it("drained beim Load-Ende den Rest, der ohne onprogress-Event ankam", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const chunks: string[] = [];
    const p = new XhrSseTransport().postStream("http://x", {}, (raw) => chunks.push(raw), new AbortController().signal);
    const xhr = FakeXhr.instances[0]!;
    xhr.push("a");
    xhr.responseText += "b"; // kein onprogress mehr — nur onload sieht das
    xhr.finish(200);
    expect(await p).toBe(200);
    expect(chunks).toEqual(["a", "b"]);
  });

  it("resolved auch bei HTTP 400 mit dem Status (Context-Overflow-Handling im Client)", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const chunks: string[] = [];
    const p = new XhrSseTransport().postStream("http://x", {}, (raw) => chunks.push(raw), new AbortController().signal);
    const xhr = FakeXhr.instances[0]!;
    xhr.push('{"error":"context length exceeded"}');
    xhr.finish(400);
    expect(await p).toBe(400);
    expect(chunks).toEqual(['{"error":"context length exceeded"}']);
  });

  it("AbortSignal → xhr.abort() → Rejection mit AbortError", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const ctrl = new AbortController();
    const p = new XhrSseTransport().postStream("http://x", {}, () => {}, ctrl.signal);
    const xhr = FakeXhr.instances[0]!;
    ctrl.abort();
    expect(xhr.aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bereits abgebrochenes Signal → sofortige Rejection, ohne einen Request zu senden", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const ctrl = new AbortController();
    ctrl.abort();
    const p = new XhrSseTransport().postStream("http://x", {}, () => {}, ctrl.signal);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("rejected bei Netzwerkfehler", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const p = new XhrSseTransport().postStream("http://x", {}, () => {}, new AbortController().signal);
    FakeXhr.instances[0]!.onerror?.();
    await expect(p).rejects.toThrow(/Netzwerkfehler/);
  });
});

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
