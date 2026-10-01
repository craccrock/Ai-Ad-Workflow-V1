# Madaket Gen Studio — Editor Guide

Madaket Gen Studio is our internal tool for generating images and video. Everything you make is saved in one shared place, so nothing gets lost in downloads folders.

## Getting in
1. Colin will send you the site address, your email and a **temporary password**.
2. Sign in with them. You'll be asked to choose your own password (at least 10 characters).
3. After that, sign in with your own password. You can change it any time with the 🔑 icon in the top-right corner.

**Forgot your password?** Message Colin. He'll send you a new temporary one.

## Making something

The **Studio** page has the form on the left and your results on the right. On a phone or tablet, results appear below the form.

1. **Pick a model.** Click the model box at the top. Every model shows its price.

   | Need | Use |
   |---|---|
   | Quick drafts and concepts | **Nano Banana 2 Lite** (about 2¢ per image) |
   | Final images, ads, text in images | **Nano Banana Pro** (about 9¢) |
   | Lots of text or exact layouts, editing with many references (up to 16) | **GPT Image 2** (3¢ at 1K, 5¢ at 2K, 8¢ at 4K) |
   | Same, but newest — and cut-outs on a transparent background | **GPT Image 2.5** (same price; Flare or Sunburst) |
   | Cheap video | **Hailuo H3** at 768P |
   | Best motion | **Kling 3.0** or **Seedance 2.0** |
   | Talking head from a voiceover | **Kling AI Avatar** (face photo + audio file) |
   | A voiceover | **ElevenLabs Voice** — pick a voice from the team's ElevenLabs library, paste the script |
   | Two people talking | **ElevenLabs Dialogue** — one line per turn, e.g. `Hank: Are those the pajamas?` |
   | Sharpening an image | **Recraft Crisp Upscale** |

2. **Write the prompt.** Be specific about subject, setting, lighting, camera and mood.
3. **Add references if you want them.** Drag files into a box or click **From library**.
   - **Image models** use reference images, e.g. to keep a product or person consistent.
   - **Video models** let you choose how to guide the clip:
     - **Start / end frame** pins exactly how it begins (and ends).
     - **References** (Omni Flash, Seedance, Hailuo H3) lets you add reference images, videos and audio for characters, products, style or motion — mention them in your prompt. Each box shows how many you can add and how many seconds of video/audio you have left.
   - **Kling 3.0 elements:** add a start frame, then add an element (a name plus 2–4 photos) and write `@name` in your prompt to keep that character or product consistent.
   - Reference videos change the price on Seedance and Omni Flash — the estimate updates as you add them.
4. **Set the options.** Aspect ratio, duration, resolution, and how many variants (1–4). Only the options the chosen model supports are shown.
5. **Check the price.** It updates live above the Generate button.
6. **Click Generate** or press **⌘ + Enter**.
   - A card appears right away.
   - Images take about 10–30 seconds. Videos take 1–5 minutes, longer when Kie is busy.
   - You get a notification when each one finishes, and you can keep working in the meantime.
   - The card tells you where the job is:
     - **Generating**, with a bar and "Usually takes about…": the bar compares the time so far with how long that model normally takes for us. It's an estimate; Kie doesn't report real progress.
     - **Taking longer than usual**: Kie is busy. The job keeps its place in line, so don't re-run it.
     - **Sent again automatically**: Kie hit an error on its side, so the job was resubmitted for you.
     - **Failed**: the card says why and what to do. Kie doesn't charge for failed jobs.
   - A yellow notice above the gallery means Kie is having trouble for everyone, not just you.

## Your results

Each card shows the model, prompt, cost, who made it and when. Its buttons:

| Button | What it does |
|---|---|
| ⬇ | Download. For images you can choose the original file or **WebP** — same picture, roughly 90% smaller, which is what you want on a web page. |
| ⧉ | Copy the prompt |
| ↻ | Re-run with the exact same settings (a fresh take) |
| ⚙ | Load its settings back into the form so you can tweak them |
| 🗑 | Delete. Click twice to confirm. You can only delete your own work. |

- **Filters** above the gallery narrow results by model, type, person or date.
- **Selecting several at once:** hover a card and click the checkbox in its top-right corner. Shift-click another card to select everything in between, or use **Select all**. With a selection active you can **Download zip** — choose original files or **Images as WebP** (one file, named `01-model-prompt.png` and so on) or **Delete** them together. Click ✕ to clear the selection.
- **Private:** generations are shared with the team by default. To keep one to yourself, open **Advanced** before generating and untick **Share with the team**.
- **Retried badge:** Kie had a temporary error and the job was resubmitted automatically. Nothing for you to do.

## Files are deleted after 7 days

Storage costs money, so **generated images and videos are deleted a week after they're made**. Everything else is kept:

- The card stays in the gallery with its prompt, settings and price, and reads "File removed after 7 days".
- Press ↻ on that card to generate it again (that costs the usual amount).
- **Files you uploaded** — product shots, voiceovers, reference clips — are never deleted.

Cards show **"Deletes in 2 days"**, then "tomorrow", then "today", as the deadline approaches. **Download anything you want to keep before then** — ⬇ on the card, or select several and use Download zip.

## Media Library
The **Library** tab holds every uploaded reference image, voiceover and generated output.
- Drag files anywhere on the page to upload.
- Click an item to preview it, download it, or click **Use in generation** to drop it straight into the form.

## Good habits
- **Draft cheap, finish expensive.** Nail the prompt on Nano Banana 2 Lite or Hailuo 768P, then switch models for the final.
- **Watch the price.** Before you click Generate, check how many variants you've selected and the video length.
- **Iterate from cards.** Use ⚙ on a result you like rather than starting from scratch.

Questions or something broken? Message Colin with a screenshot of the card or error.
