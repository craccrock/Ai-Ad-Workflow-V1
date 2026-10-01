/**
 * Sanity checks for models.config.ts + pricing/validation/input mapping. Run: npm test
 * Pure logic only — no network, no keys.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { canFallback, fallbackModel, getModel, models } from "../src/config/models.config";
import { actualCost, estimateCost, validateParams } from "../src/lib/generation-params";

test("every model has a unique id, valid defaults, a Kie mapping and a price for each option", () => {
  const ids = new Set<string>();
  for (const m of models) {
    assert.ok(!ids.has(m.id), `duplicate id ${m.id}`);
    ids.add(m.id);
    const o = m.options;
    if (o.defaultResolution) assert.ok(o.resolutions?.includes(o.defaultResolution), `${m.id} default resolution`);
    if (o.defaultDuration) assert.ok(o.durations?.includes(o.defaultDuration), `${m.id} default duration`);
    if (o.defaultAspectRatio) assert.ok(o.aspectRatios?.includes(o.defaultAspectRatio), `${m.id} default aspect`);
    if (m.provider === "kie") assert.ok(m.mapInput, `${m.id} Kie model needs mapInput`);

    // Every selectable combination must produce a price, on the primary and on the backup.
    // Speech models are priced per character, so they need a script to price at all.
    const prompt = m.inputTypes.includes("text-to-dialogue") ? "Narrator: Ten chars." : "Ten chars.";
    for (const variant of [m, fallbackModel(m)].filter(Boolean)) {
      for (const resolution of o.resolutions ?? [undefined]) {
        for (const duration of o.durations ?? [undefined]) {
          const e = estimateCost(variant!, { prompt, resolution, duration, audio_duration_seconds: 10, image_urls: [] }, 1, { sourceVideoSeconds: 10 });
          assert.ok(e.perGeneration != null && e.perGeneration > 0, `${variant!.id} (${variant!.provider}) has no price for ${resolution}/${duration}`);
        }
      }
    }
  }
});

test("only Google models have a Google backup", () => {
  const withBackup = models.filter((m) => m.fallback).map((m) => m.id).sort();
  assert.deepEqual(withBackup, ["gemini-omni-1.1-flash", "nano-banana-2", "nano-banana-2-lite", "nano-banana-pro"]);
  for (const m of models.filter((x) => x.fallback)) assert.equal(m.fallback!.provider, "google");
});

test("lookup by provider model string", () => {
  assert.equal(getModel("kling/ai-avatar-standard")?.id, "kling-avatar-standard");
  assert.equal(getModel("gemini-3-pro-image")?.id, "nano-banana-pro");
  assert.equal(getModel("minimax-h3/image-to-video")?.id, "hailuo-h3");
});

test("Omni Flash: Kie per-clip price, Google backup per-second price, Kie request shape", () => {
  const m = getModel("gemini-omni-1.1-flash")!;
  const v = validateParams(m, { prompt: "a dog on a beach", duration: 8, resolution: "4K", image_urls: ["https://a", "https://b"] });
  assert.ok(v.ok);
  assert.equal(estimateCost(m, v.params, 2).total!.toFixed(3), (2 * 189 * 0.005).toFixed(3));
  assert.equal(estimateCost(m, { ...v.params, resolution: "720p" }).perGeneration!.toFixed(3), "0.525");
  assert.equal(estimateCost(fallbackModel(m)!, { ...v.params, resolution: "720p" }).perGeneration!.toFixed(3), (8 * 0.101).toFixed(3));
  assert.deepEqual(m.mapInput!(v.params, v.mode), {
    prompt: "a dog on a beach",
    duration: "8",
    resolution: "4k",
    aspect_ratio: "9:16",
    first_frame_url: "https://a",
    last_frame_url: "https://b",
  });
});

test("Kie reported credits override the estimate; Google tokens used on backup", () => {
  const m = getModel("nano-banana-pro")!;
  const v = validateParams(m, { prompt: "x" });
  assert.ok(v.ok);
  assert.equal(actualCost(m, v.params, { costUsd: 0.09 }, 0.2), 0.09);
  const omniBackup = fallbackModel(getModel("gemini-omni-1.1-flash")!)!;
  assert.equal(actualCost(omniBackup, v.params, { videoOutputTokens: 46336 }, 0.8)!.toFixed(4), "0.8109");
});

test("avatar requires image + audio, prices by audio length, sends Kie fields", () => {
  const m = getModel("kling-avatar-pro")!;
  assert.equal(validateParams(m, { prompt: "hi" }).ok, false);
  const v = validateParams(m, { image_url: "https://x/y.png", audio_url: "https://x/a.mp3", audio_duration_seconds: 12.3 });
  assert.ok(v.ok);
  assert.equal(v.mode, "audio-to-video");
  assert.equal(estimateCost(m, v.params).perGeneration!.toFixed(2), (13 * 0.08).toFixed(2));
  assert.deepEqual(m.mapInput!(v.params, v.mode), { image_url: "https://x/y.png", audio_url: "https://x/a.mp3", prompt: "" });
});

test("Kling 3.0 tiers share one Kie model and differ by mode; audio pricing", () => {
  const pro = getModel("kling-3-pro")!;
  const v = validateParams(pro, { prompt: "p", image_urls: ["https://a", "https://b"], duration: 10, generate_audio: true });
  assert.ok(v.ok);
  const input = pro.mapInput!(v.params, v.mode);
  assert.equal(input.mode, "pro");
  assert.equal(input.sound, true);
  assert.equal(input.duration, "10");
  assert.deepEqual(input.image_urls, ["https://a", "https://b"]);
  assert.equal(estimateCost(pro, v.params).perGeneration!.toFixed(2), (10 * 27 * 0.005).toFixed(2));
  assert.equal(getModel("kling-3-4k")!.mapInput!(v.params, v.mode).mode, "4K");
});

test("mode-specific Kie model strings", () => {
  const flux = getModel("flux-2-pro")!;
  const edit = validateParams(flux, { prompt: "x", image_urls: ["https://a"] });
  assert.ok(edit.ok);
  assert.equal(flux.endpoints![edit.mode], "flux-2/pro-image-to-image");
  assert.deepEqual(flux.mapInput!(edit.params, edit.mode).input_urls, ["https://a"]);

  const h3 = getModel("hailuo-h3")!;
  const t2v = validateParams(h3, { prompt: "x" });
  assert.ok(t2v.ok);
  assert.equal(h3.endpoints![t2v.mode], "minimax-h3/text-to-video");
  assert.equal(h3.mapInput!(t2v.params, t2v.mode).duration, 6);
});

test("rejects out-of-range options and too many images", () => {
  const m = getModel("nano-banana-2-lite")!;
  const v = validateParams(m, { prompt: "x", resolution: "4K", aspect_ratio: "7:3" });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.errors.length, 2);
  const omni = getModel("gemini-omni-1.1-flash")!;
  assert.equal(validateParams(omni, { prompt: "x", image_urls: ["https://1", "https://2", "https://3"] }).ok, false);
  assert.equal(validateParams(omni, { prompt: "x", duration: 5 }).ok, false);
});

test("extra fields pass through to Kie input last", () => {
  const m = getModel("seedream-5-pro")!;
  const v = validateParams(m, { prompt: "x", aspect_ratio: "9:16", extra: { output_format: "jpeg" } });
  assert.ok(v.ok);
  assert.deepEqual(m.mapInput!(v.params, v.mode), { prompt: "x", aspect_ratio: "9:16", quality: "high", output_format: "jpeg" });
});

// ─── references ─────────────────────────────────────────────────────────────

const img = (n: number) => Array.from({ length: n }, (_, i) => `https://r/img${i}.png`);
const vid = (n: number) => Array.from({ length: n }, (_, i) => `https://r/vid${i}.mp4`);

test("Seedance 2.5: pricing with and without a reference video", () => {
  const m = getModel("seedance-2.5")!;
  const plain = validateParams(m, { prompt: "x", resolution: "720p", duration: 8 });
  assert.ok(plain.ok);
  assert.equal(estimateCost(m, plain.params).perGeneration!.toFixed(3), (8 * 63 * 0.005).toFixed(3));
  const withVideo = validateParams(m, { prompt: "x", resolution: "720p", duration: 8, reference_video_urls: vid(1), reference_video_durations: [12] });
  assert.ok(withVideo.ok);
  assert.equal(estimateCost(m, withVideo.params).perGeneration!.toFixed(3), (8 * 38 * 0.005).toFixed(3));
  assert.equal(withVideo.mode, "reference-to-video");
});

test("Seedance: references map to Kie fields and frames are left out", () => {
  const m = getModel("seedance-2")!;
  const v = validateParams(m, { prompt: "x", reference_image_urls: img(2), reference_video_urls: vid(1), reference_audio_urls: ["https://r/a.mp3"] });
  assert.ok(v.ok);
  const input = m.mapInput!(v.params, v.mode);
  assert.deepEqual(input.reference_image_urls, img(2));
  assert.deepEqual(input.reference_video_urls, vid(1));
  assert.deepEqual(input.reference_audio_urls, ["https://r/a.mp3"]);
  assert.equal(input.first_frame_url, undefined);
});

test("frames and references can't be mixed where the provider forbids it", () => {
  for (const id of ["seedance-2-fast", "seedance-2.5", "gemini-omni-1.1-flash", "hailuo-h3"]) {
    const v = validateParams(getModel(id)!, { prompt: "x", start_frame_url: "https://r/start.png", reference_image_urls: img(1) });
    assert.equal(v.ok, false, id);
    if (!v.ok) assert.match(v.errors.join(" "), /not both/);
  }
});

test("reference limits: counts and total clip length", () => {
  const s2 = getModel("seedance-2")!;
  assert.equal(validateParams(s2, { prompt: "x", reference_image_urls: img(10) }).ok, false);
  const tooLong = validateParams(s2, { prompt: "x", reference_video_urls: vid(2), reference_video_durations: [10, 8] });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.errors.join(" "), /15s/);
  // 2.5 allows 30 images and 30s of video
  assert.ok(validateParams(getModel("seedance-2.5")!, { prompt: "x", reference_image_urls: img(30), reference_video_urls: vid(2), reference_video_durations: [15, 15] }).ok);
});

test("Omni: slot budget, trimmed video_list, flat video price, no Google backup for references", () => {
  const m = getModel("gemini-omni-1.1-flash")!;
  const fits = validateParams(m, { prompt: "x", reference_image_urls: img(5), reference_video_urls: vid(1), reference_video_durations: [6.5] });
  assert.ok(fits.ok);
  assert.equal(validateParams(m, { prompt: "x", reference_image_urls: img(6), reference_video_urls: vid(1) }).ok, false);

  const input = m.mapInput!(fits.params, fits.mode);
  assert.deepEqual(input.video_list, [{ url: "https://r/vid0.mp4", start: 0, ends: 6.5 }]);
  assert.deepEqual(input.image_urls, img(5));
  assert.equal(input.first_frame_url, undefined);

  assert.equal(estimateCost(m, { ...fits.params, resolution: "1080p" }).perGeneration, 0.84);
  assert.equal(estimateCost(m, { ...fits.params, resolution: "4K" }).perGeneration, 1.26);
  assert.equal(canFallback(m, fits.params), false);

  const framesOnly = validateParams(m, { prompt: "x", start_frame_url: "https://r/s.png", end_frame_url: "https://r/e.png" });
  assert.ok(framesOnly.ok);
  assert.equal(canFallback(m, framesOnly.params), true);
});

test("Hailuo H3: reference mode endpoint, audio needs a visual, per-image cost", () => {
  const m = getModel("hailuo-h3")!;
  const refs = validateParams(m, { prompt: "x", reference_image_urls: img(2) });
  assert.ok(refs.ok);
  assert.equal(m.endpoints![refs.mode], "minimax-h3/reference-to-video");
  assert.equal(m.mapInput!(refs.params, refs.mode).aspect_ratio, "9:16");

  const audioOnly = validateParams(m, { prompt: "x", reference_audio_urls: ["https://r/a.mp3"] });
  assert.equal(audioOnly.ok, false);

  const frames = validateParams(m, { prompt: "x", start_frame_url: "https://r/s.png", end_frame_url: "https://r/e.png", resolution: "768P", duration: 6 });
  assert.ok(frames.ok);
  assert.equal(frames.mode, "image-to-video");
  assert.equal(estimateCost(m, frames.params).perGeneration!.toFixed(2), (6 * 0.04 + 2 * 0.02).toFixed(2));
});

test("Kling 3.0 elements: mapping and rules", () => {
  const m = getModel("kling-3-pro")!;
  const good = validateParams(m, {
    prompt: "@hero walks in",
    start_frame_url: "https://r/start.png",
    elements: [{ name: "hero", image_urls: img(3) }],
  });
  assert.ok(good.ok);
  assert.deepEqual(m.mapInput!(good.params, good.mode).kling_elements, [{ name: "hero", description: "hero", element_input_urls: img(3) }]);

  const noFrame = validateParams(m, { prompt: "x", elements: [{ name: "hero", image_urls: img(2) }] });
  assert.equal(noFrame.ok, false);
  const badName = validateParams(m, { prompt: "x", start_frame_url: "https://r/s.png", elements: [{ name: "my hero!", image_urls: img(2) }] });
  assert.equal(badName.ok, false);
  const tooFew = validateParams(m, { prompt: "x", start_frame_url: "https://r/s.png", elements: [{ name: "hero", image_urls: img(1) }] });
  assert.equal(tooFew.ok, false);
});

test("Kling 2.6 takes a start frame only", () => {
  const m = getModel("kling-2.6")!;
  assert.equal(validateParams(m, { prompt: "x", start_frame_url: "https://r/s.png", end_frame_url: "https://r/e.png" }).ok, false);
  const ok = validateParams(m, { prompt: "x", start_frame_url: "https://r/s.png" });
  assert.ok(ok.ok);
  assert.deepEqual(m.mapInput!(ok.params, ok.mode).image_urls, ["https://r/s.png"]);
});

test("GPT Image 2: prices, text vs edit endpoints, and Kie's resolution rules", () => {
  const m = getModel("gpt-image-2")!;
  const at = (resolution: string, aspect_ratio = "16:9") => validateParams(m, { prompt: "poster", resolution, aspect_ratio });

  for (const [res, usd] of [["1K", 0.03], ["2K", 0.05], ["4K", 0.08]] as const) {
    const v = at(res);
    assert.ok(v.ok, res);
    assert.equal(estimateCost(m, v.params).perGeneration, usd, res);
  }

  const t2i = at("2K", "1:1");
  assert.ok(t2i.ok);
  assert.equal(t2i.mode, "text-to-image");
  assert.equal(m.endpoints![t2i.mode], "gpt-image-2-text-to-image");
  assert.equal(m.mapInput!(t2i.params, t2i.mode).input_urls, undefined);

  const edit = validateParams(m, { prompt: "make it a poster", image_urls: img(3), resolution: "1K", aspect_ratio: "4:5" });
  assert.ok(edit.ok);
  assert.equal(edit.mode, "image-edit");
  assert.equal(m.endpoints![edit.mode], "gpt-image-2-image-to-image");
  assert.deepEqual(m.mapInput!(edit.params, edit.mode).input_urls, img(3));

  assert.equal(at("2K", "4:5").ok, false, "4:5 isn't available at 2K");
  assert.equal(at("4K", "1:1").ok, false, "1:1 isn't available at 4K");
  assert.equal(at("2K", "auto").ok, false, "auto is 1K only");
  assert.ok(at("1K", "auto").ok);
  assert.ok(at("4K", "4:5").ok);
  assert.equal(validateParams(m, { prompt: "x", image_urls: img(17) }).ok, false, "max 16 reference images");
});

test("ElevenLabs models run direct, priced per character, with voices from the account", () => {
  const ids = ["elevenlabs-v3", "elevenlabs-multilingual-v2", "elevenlabs-flash-v2-5", "elevenlabs-dialogue"];
  for (const id of ids) {
    const m = getModel(id);
    assert.ok(m, `${id} missing`);
    assert.equal(m!.provider, "elevenlabs", `${id} should not go through Kie`);
    assert.equal(m!.mediaType, "audio");
    assert.equal(m!.mapInput, undefined, `${id} builds its payload in the provider, not mapInput`);
  }

  // Per-character pricing: 1,000 characters costs the model's rate.
  const v3 = getModel("elevenlabs-v3")!;
  const thousand = "a".repeat(1000);
  assert.equal(estimateCost(v3, { prompt: thousand }).perGeneration, 0.1);
  assert.equal(estimateCost(getModel("elevenlabs-flash-v2-5")!, { prompt: thousand }).perGeneration, 0.05);
  assert.equal(estimateCost(v3, { prompt: "12345" }).perGeneration, 0.0005);

  // The voice list is filled from the signed-in library, so the config ships none.
  const voiceField = v3.options.fields!.find((f) => f.key === "voice")!;
  assert.equal(voiceField.optionsFrom, "voices");
  assert.deepEqual(voiceField.options, []);
  // A voice the config can't know about must still pass validation (the provider checks it).
  assert.ok(validateParams(v3, { prompt: "hi", settings: { voice: "SomeClonedVoiceId" } }).ok);

  // Dialogue: any "Name: line" parses, and only the spoken text is billed.
  const dlg = getModel("elevenlabs-dialogue")!;
  assert.ok(validateParams(dlg, { prompt: "Dr. Pickle: Hello there.\nCat lady narrator: Hi." }).ok);
  assert.equal(estimateCost(dlg, { prompt: "Dr. Pickle: " + "a".repeat(1000) }).perGeneration, 0.1);
  assert.equal(validateParams(dlg, { prompt: "no voice prefix here" }).ok, false);
  assert.equal(validateParams(dlg, { prompt: "Narrator: " + "a".repeat(2001) }).ok, false, "2000 character cap");
});

test("GPT Image 2.5: both tiers, transparent background, no aspect restrictions", () => {
  for (const [id, slug] of [["gpt-image-2-5-flare", "gpt-image-2-5-flare"], ["gpt-image-2-5-sunburst", "gpt-image-2-5-sunburst"]]) {
    const m = getModel(id)!;
    assert.ok(m, `${id} missing`);
    assert.equal(m.family, "gpt-image-2-5");
    assert.equal(m.endpoints!["text-to-image"], `${slug}-text-to-image`);
    assert.equal(m.endpoints!["image-edit"], `${slug}-image-to-image`);

    // Verified live on Kie: 6 credits at 1K.
    assert.equal(estimateCost(m, { prompt: "x", resolution: "1K" }).perGeneration, 0.03);
    assert.equal(estimateCost(m, { prompt: "x", resolution: "4K" }).perGeneration, 0.08);

    // 2.5 has no "this ratio can't do that resolution" rules, unlike GPT Image 2.
    assert.ok(validateParams(m, { prompt: "x", resolution: "4K", aspect_ratio: "1:1" }).ok);
    assert.ok(validateParams(m, { prompt: "x", resolution: "2K", aspect_ratio: "9:8" }).ok);

    const edit = validateParams(m, { prompt: "cut it out", image_urls: img(2), settings: { background: "transparent" } });
    assert.ok(edit.ok);
    assert.equal(edit.mode, "image-edit");
    const sent = m.mapInput!(edit.params, edit.mode);
    assert.equal(sent.background, "transparent");
    assert.deepEqual(sent.input_urls, img(2));
    assert.equal(validateParams(m, { prompt: "x", image_urls: img(17) }).ok, false, "max 16 references");
  }
});
