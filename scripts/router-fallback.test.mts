import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls: string[] = [];
/** Kie responses in order; the last one repeats. */
let kieResults: unknown[] = [{ status: "queued", requestId: "task_1", endpoint: "nano-banana-pro" }];
const nextKie = () => (kieResults.length > 1 ? kieResults.shift() : kieResults[0]);
mock.module("./../src/providers/kie.ts", { namedExports: { kieProvider: { start: async (m: { providerModelId: string }) => (calls.push(`kie:${m.providerModelId}`), nextKie()), poll: async () => ({}) } } });
mock.module("./../src/providers/google.ts", { namedExports: { googleProvider: { start: async (m: { providerModelId: string; pricing: { unit: string } }) => (calls.push(`google:${m.providerModelId}:${m.pricing.unit}`), { status: "completed", endpoint: m.providerModelId, output: { files: [], usage: {} } }), poll: async () => ({}) } } });

const { canUseBackup, submitGeneration, submitToFallback } = await import("../src/providers/router.ts");
const { getModel } = await import("../src/config/models.config.ts");
const { validateParams } = await import("../src/lib/generation-params.ts");
const { isTransientProviderError } = await import("../src/providers/retry.ts");
const { awaitingCopy, describeFailure, describeInFlight, expiryInfo, formatApprox, recentProviderTrouble, summarizeDurations, typicalFor } = await import("../src/lib/job-status.ts");

/** Most scenarios below exercise the backup path, so switch it on; the "backup off" tests turn it off. */
process.env.GOOGLE_BACKUP = "on";

const noDelay = { delayMs: () => 0 };
const fail = (error: string, endpoint = "nano-banana-pro") => ({ status: "failed", error, endpoint });
const queued = (id: string) => ({ status: "queued", requestId: id, endpoint: "nano-banana-pro" });

const nbp = getModel("nano-banana-pro")!;
const v = validateParams(nbp, { prompt: "x" });
if (!v.ok) throw new Error("invalid");

test("classifier: temporary vs permanent provider errors", () => {
  for (const msg of ["524: generate task timeout", "Kie 500: Internal Error, Please try again later.", "Kie 429: rate limited", "Kie 455: service under maintenance", "fetch failed", "501: Generation failed"]) {
    assert.equal(isTransientProviderError(msg), true, msg);
  }
  for (const msg of ["Kie 402: Credits insufficient", "Kie 401: You do not have access permissions", "Kie 422: validation error", "400: content policy violation", "", undefined]) {
    assert.equal(isTransientProviderError(msg), false, String(msg));
  }
});

test("Kie accepts → no retry, no fallback", async () => {
  calls.length = 0;
  kieResults = [queued("task_1")];
  const r = await submitGeneration(nbp, v.params, { mode: v.mode }, noDelay);
  assert.deepEqual(calls, ["kie:nano-banana-pro"]);
  assert.equal(r.ranOn.provider, "kie");
  assert.equal(r.retries.length, 0);
  assert.equal(r.fallbackReason, undefined);
});

test("temporary Kie error → retried on Kie and succeeds, Google never called", async () => {
  calls.length = 0;
  kieResults = [fail("Kie 500: Internal Error, Please try again later."), queued("task_2")];
  const r = await submitGeneration(nbp, v.params, { mode: v.mode }, noDelay);
  assert.deepEqual(calls, ["kie:nano-banana-pro", "kie:nano-banana-pro"]);
  assert.equal(r.state.status, "queued");
  assert.equal(r.ranOn.provider, "kie");
  assert.equal(r.retries.length, 1);
  assert.equal(r.retries[0].stage, "submit");
});

test("temporary Kie error keeps happening → two retries, then Google backup", async () => {
  calls.length = 0;
  kieResults = [fail("524: generate task timeout")];
  const r = await submitGeneration(nbp, v.params, { mode: v.mode }, noDelay);
  assert.deepEqual(calls, ["kie:nano-banana-pro", "kie:nano-banana-pro", "kie:nano-banana-pro", "google:gemini-3-pro-image:per_image"]);
  assert.equal(r.ranOn.provider, "google");
  assert.match(r.fallbackReason!, /after 2 retries/);
});

test("backup off (default): Kie errors never reach Google", async () => {
  delete process.env.GOOGLE_BACKUP;
  try {
    calls.length = 0;
    kieResults = [fail("Kie 500: Internal Error")];
    const r = await submitGeneration(nbp, v.params, { mode: v.mode }, noDelay);
    assert.deepEqual(calls, ["kie:nano-banana-pro", "kie:nano-banana-pro", "kie:nano-banana-pro"]);
    assert.equal(r.ranOn.provider, "kie");
    assert.equal(r.state.status, "failed");
    assert.equal(r.fallbackReason, undefined);
    assert.match((r.state as { error: string }).error, /500.*after 2 retries/);

    calls.length = 0;
    kieResults = [fail("Kie 402: insufficient credits")];
    const p = await submitGeneration(nbp, v.params, { mode: v.mode }, noDelay);
    assert.deepEqual(calls, ["kie:nano-banana-pro"]);
    assert.equal(p.ranOn.provider, "kie");
    assert.equal(canUseBackup(nbp, v.params), false);
    assert.equal(submitToFallback(nbp, v.params, { mode: v.mode }), null);
  } finally {
    process.env.GOOGLE_BACKUP = "on";
  }
});

test("permanent Kie error → no retry, straight to Google", async () => {
  calls.length = 0;
  kieResults = [fail("Kie 402: insufficient credits")];
  const r = await submitGeneration(nbp, v.params, { mode: v.mode }, noDelay);
  assert.deepEqual(calls, ["kie:nano-banana-pro", "google:gemini-3-pro-image:per_image"]);
  assert.equal(r.retries.length, 0);
  assert.match(r.fallbackReason!, /402/);
});

test("Kie-only model: temporary error retried twice, then fails with no backup", async () => {
  calls.length = 0;
  kieResults = [fail("Kie 500: Internal Error", "kling-3.0/video")];
  const kling = getModel("kling-3-pro")!;
  const kv = validateParams(kling, { prompt: "x" });
  if (!kv.ok) throw new Error("invalid");
  const r = await submitGeneration(kling, kv.params, { mode: kv.mode }, noDelay);
  assert.deepEqual(calls, ["kie:kling-3.0/video", "kie:kling-3.0/video", "kie:kling-3.0/video"]);
  assert.equal(r.state.status, "failed");
  assert.equal(submitToFallback(kling, kv.params, { mode: kv.mode }), null);
});

const baseGen = { provider: "kie" as const, created_at: new Date(Date.now() - 60_000).toISOString(), result_metadata: null, error: null };

test("card status: typical-time estimate, slow note and retry messages", () => {
  const now = Date.now();
  const at = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
  // Kie reports "waiting" for the whole run, so both states read "Generating".
  assert.deepEqual(describeInFlight({ ...baseGen, status: "queued", media_type: "image", created_at: at(60) }, now), { label: "Generating", progress: undefined, expected: undefined, notes: [] });

  const samples = [100, 110, 120, 130, 300].map((secs, i) => ({ model: "nano-banana-pro", duration_seconds: null, created_at: at(10_000 + i), completed_at: at(10_000 + i - secs) }));
  const typical = summarizeDurations(samples);
  assert.equal(typical["nano-banana-pro"].median, 120);
  assert.equal(typical["nano-banana-pro"].n, 5);
  assert.equal(summarizeDurations(samples.slice(0, 2))["nano-banana-pro"], undefined, "needs 3+ samples");

  const nbp = { ...baseGen, model: "nano-banana-pro", media_type: "image" as const, status: "queued" as const };
  const early = describeInFlight({ ...nbp, created_at: at(60) }, now, typical);
  assert.equal(early.expected, "Usually takes about 2m");
  assert.equal(early.progress, 0.5);
  assert.equal(early.notes.length, 0);
  assert.equal(describeInFlight({ ...nbp, created_at: at(200) }, now, typical).progress, 0.95, "capped below 100%");
  assert.match(describeInFlight({ ...nbp, created_at: at(400) }, now, typical).notes.join(" "), /longer than usual/);

  // No history: images count as slow after 3 min.
  assert.match(describeInFlight({ ...baseGen, status: "queued", media_type: "image", created_at: at(4 * 60) }, now).notes.join(" "), /longer than usual/);

  const retried = describeInFlight(
    { ...baseGen, status: "queued", media_type: "video", result_metadata: { retried_at: at(30), retries: [{ at: "", stage: "in-flight", error: "500: Internal Error" }] } },
    now,
  );
  assert.match(retried.notes[0], /server error \(500\).*try 2 of 3/);
  assert.equal(retried.notes.length, 1, "the slow timer restarts with the resubmission");
});

test("typical time prefers the same clip length for videos", () => {
  const now = Date.now();
  const at = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
  const mk = (dur: number, secs: number) => ({ model: "gemini-omni-1.1-flash", duration_seconds: dur, created_at: at(9000), completed_at: at(9000 - secs) });
  const typical = summarizeDurations([mk(10, 150), mk(10, 160), mk(10, 170), mk(4, 60), mk(4, 70), mk(4, 80)]);
  assert.equal(typicalFor({ ...baseGen, status: "queued", model: "gemini-omni-1.1-flash", duration_seconds: 10 }, typical)!.median, 160);
  assert.equal(typicalFor({ ...baseGen, status: "queued", model: "gemini-omni-1.1-flash", duration_seconds: 4 }, typical)!.median, 70);
  assert.ok(typicalFor({ ...baseGen, status: "queued", model: "gemini-omni-1.1-flash", duration_seconds: 8 }, typical), "falls back to the model overall");
  assert.equal(formatApprox(42), "about 40s");
  assert.equal(formatApprox(110), "about 1m 50s");
});

test("card status: failures explained in plain English", () => {
  const f = (error: string) => describeFailure({ ...baseGen, status: "failed", error });
  assert.match(f("kie: 500: Internal Error, Please try again later. (after 2 retries)").title, /server error \(500\)/);
  assert.match(f("kie: 524: generate task timeout.").title, /timeout \(524\)/);
  assert.match(f("kie: 500: Internal Error").advice, /weren't charged/);
  assert.match(f("Kie 402: Credits insufficient").title, /out of credits/);
  assert.match(f("400: Request blocked: The audio was filtered due to copyright or safety risks.").title, /safety filter/);
  assert.match(f("400: Your prompt was flagged by Website as violating content policies.").title, /safety filter/);
  assert.match(f("Timed out: no result after 60 min on kie").title, /never returned/);
  assert.equal(f("something odd").title, "Generation failed");
});

test("gallery heads-up after 2+ recent Kie errors", () => {
  const now = Date.now();
  const bad = { ...baseGen, status: "failed" as const, error: "kie: 500: Internal Error" };
  assert.equal(recentProviderTrouble([bad], now), null);
  assert.equal(recentProviderTrouble([bad, bad], now)?.count, 2);
  const old = { ...bad, created_at: new Date(now - 60 * 60_000).toISOString() };
  assert.equal(recentProviderTrouble([old, old], now), null);
  const blocked = { ...bad, error: "400: content policy" };
  assert.equal(recentProviderTrouble([blocked, blocked], now), null);
});

test("file retention: countdown near the deadline, then a removed card", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const done = (daysAgo: number) => ({
    ...baseGen,
    status: "completed" as const,
    result_url: "https://x/out.png",
    completed_at: new Date(now - daysAgo * day).toISOString(),
  });

  assert.equal(expiryInfo(done(1), now, 7).notice, undefined, "no warning a day in");
  assert.equal(expiryInfo(done(1), now, 7).daysLeft, 6);
  assert.equal(expiryInfo(done(5), now, 7).notice, "Deletes in 2 days");
  assert.equal(expiryInfo(done(6), now, 7).notice, "Deletes tomorrow");
  assert.equal(expiryInfo(done(6.9), now, 7).notice, "Deletes today");
  assert.equal(expiryInfo(done(9), now, 7).daysLeft, 0, "overdue but not yet swept");

  // Retention off, or a job with no file, means no countdown at all.
  assert.deepEqual(expiryInfo(done(6), now, null), { deleted: false });
  assert.deepEqual(expiryInfo({ ...done(6), result_url: null }, now, 7), { deleted: false });
  assert.deepEqual(expiryInfo({ ...baseGen, status: "failed", result_url: null, completed_at: new Date(now).toISOString() }, now, 7), { deleted: false });

  const swept = { ...done(9), result_url: null, result_metadata: { file_deleted_at: new Date(now).toISOString(), retention_days: 7 } };
  assert.deepEqual(expiryInfo(swept, now, 7), { deleted: true });
});

test("a finished job still hosted by the provider shows as copying, not as a broken image", () => {
  const stored = { ...baseGen, status: "completed" as const, result_url: "https://x.supabase.co/storage/v1/object/public/generations/u/1.png", result_metadata: null };
  assert.equal(awaitingCopy(stored), false);

  const onProvider = { ...stored, result_url: "https://tempfile.aiquickdraw.com/js/g4/abc.jpg", result_metadata: { provider_url_only: true } };
  assert.equal(awaitingCopy(onProvider), true);

  // Once the sweep copies it over, the flag is gone and the card shows the picture.
  const recopied = { ...stored, result_metadata: { recopied_at: new Date().toISOString() } };
  assert.equal(awaitingCopy(recopied), false);
  assert.equal(awaitingCopy({ ...onProvider, status: "failed" }), false);
});
