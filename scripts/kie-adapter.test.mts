/** Kie adapter request/response handling against a mocked fetch (shapes from docs.kie.ai). */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.KIE_API_KEY = "test-key";
const { kieProvider } = await import("../src/providers/kie.ts");
const { getModel } = await import("../src/config/models.config.ts");
const { validateParams } = await import("../src/lib/generation-params.ts");

type Captured = { url: string; init?: RequestInit };
function mockFetch(body: unknown, status = 200) {
  const captured: Captured[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return captured;
}

const kling = getModel("kling-3-std")!;
const v = validateParams(kling, { prompt: "ferry deck", image_urls: ["https://img/a.png"] });
if (!v.ok) throw new Error("invalid");

test("createTask sends model, input, callback and bearer key", async () => {
  const cap = mockFetch({ code: 200, msg: "success", data: { taskId: "task_kling_1" } });
  const state = await kieProvider.start(kling, v.params, { mode: v.mode, webhookUrl: "https://app/api/webhooks/kie" });
  assert.deepEqual(state, { status: "queued", requestId: "task_kling_1", endpoint: "kling-3.0/video" });
  assert.equal(cap[0].url, "https://api.kie.ai/api/v1/jobs/createTask");
  assert.equal((cap[0].init!.headers as Record<string, string>).Authorization, "Bearer test-key");
  const sent = JSON.parse(cap[0].init!.body as string);
  assert.equal(sent.model, "kling-3.0/video");
  assert.equal(sent.callBackUrl, "https://app/api/webhooks/kie");
  assert.equal(sent.input.mode, "std");
  assert.deepEqual(sent.input.image_urls, ["https://img/a.png"]);
});

test("Kie error envelope (HTTP 200, code 402) becomes a failed state", async () => {
  mockFetch({ code: 402, msg: "Credits insufficient", data: null });
  const state = await kieProvider.start(kling, v.params, { mode: v.mode });
  assert.equal(state.status, "failed");
  assert.match((state as { error: string }).error, /402.*insufficient/i);
});

test("recordInfo success → files + real cost from credits", async () => {
  mockFetch({
    code: 200,
    msg: "success",
    data: { taskId: "task_kling_1", model: "kling-3.0/video", state: "success", resultJson: '{"resultUrls":["https://cdn.kie/out.mp4"]}', creditsConsumed: 70, failCode: "", failMsg: "" },
  });
  const state = await kieProvider.poll(kling, "task_kling_1", "kling-3.0/video");
  assert.equal(state.status, "completed");
  if (state.status !== "completed") return;
  assert.deepEqual(state.output.files, [{ url: "https://cdn.kie/out.mp4", mimeType: "video/mp4" }]);
  assert.equal(state.output.usage.costUsd, 0.35);
});

test("recordInfo states map to queued / processing / failed", async () => {
  for (const [kieState, expected] of [["waiting", "queued"], ["queuing", "queued"], ["generating", "processing"]] as const) {
    mockFetch({ code: 200, msg: "success", data: { taskId: "t", model: "m", state: kieState } });
    assert.equal((await kieProvider.poll(kling, "t", "m")).status, expected);
  }
  mockFetch({ code: 200, msg: "success", data: { taskId: "t", model: "m", state: "fail", failCode: "501", failMsg: "Generation failed" } });
  const failed = await kieProvider.poll(kling, "t", "m");
  assert.deepEqual(failed, { status: "failed", error: "501: Generation failed", requestId: "t", endpoint: "m" });
});
