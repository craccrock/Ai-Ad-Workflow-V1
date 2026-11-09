import React from "react";
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { paginate, PRESETS, type PresetId, type Word } from "./pages";

const montserrat = loadMontserrat("normal", { weights: ["800", "900"], subsets: ["latin"] });
const inter = loadInter("normal", { weights: ["600", "700"], subsets: ["latin"] });

export type CaptionsProps = {
  src: string;
  words: Word[];
  preset: PresetId;
  /** 0–1 from the top: where the caption block is centred. */
  y?: number;
};

const strip = (s: string) => s.replace(/^[“"'(]+|[”"').,!?;:]+$/g, "");

/**
 * The finished ad with burned-in captions. Three looks:
 *  - capcut:  uppercase bold words in a dark rounded pill, the word being spoken in yellow and slightly larger
 *  - hormozi: huge bold words, no box, thick outline, the current word in a solid colour
 *  - clean:   one sentence-ish line in a semi-transparent bar, plain white
 */
export const Captions: React.FC<CaptionsProps> = ({ src, words, preset, y }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const spec = PRESETS[preset];
  const pages = React.useMemo(() => paginate(words, spec), [words, spec]);
  const page = pages.find((p) => t >= p.start && t < p.end);
  const scale = width / 1080; // sizes below are designed at 1080 wide
  const centreY = (y ?? (preset === "clean" ? 0.8 : 0.72)) * height;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <OffthreadVideo src={src} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      {page ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: centreY, transform: "translateY(-50%)", display: "flex", justifyContent: "center", padding: `0 ${60 * scale}px` }}>
          {preset === "capcut" ? (
            <div style={{ background: "rgba(10,10,14,0.78)", borderRadius: 22 * scale, padding: `${18 * scale}px ${30 * scale}px`, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: `${8 * scale}px ${16 * scale}px`, maxWidth: "100%" }}>
              {page.words.map((w, i) => {
                const on = t >= w.start && t < (page.words[i + 1]?.start ?? w.end + 0.3);
                return (
                  <span key={i} style={{ fontFamily: montserrat.fontFamily, fontWeight: 900, fontSize: (on ? 74 : 66) * scale, lineHeight: 1.1, textTransform: "uppercase", color: on ? "#FFD60A" : "#FFFFFF", letterSpacing: 0.5 * scale, transition: "none", textShadow: `0 ${2 * scale}px ${6 * scale}px rgba(0,0,0,0.5)` }}>
                    {strip(w.text)}
                  </span>
                );
              })}
            </div>
          ) : preset === "hormozi" ? (
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: `${6 * scale}px ${22 * scale}px`, maxWidth: "100%" }}>
              {page.words.map((w, i) => {
                const on = t >= w.start && t < (page.words[i + 1]?.start ?? w.end + 0.3);
                return (
                  <span
                    key={i}
                    style={{
                      fontFamily: montserrat.fontFamily,
                      fontWeight: 900,
                      fontSize: 92 * scale,
                      lineHeight: 1.05,
                      textTransform: "uppercase",
                      color: on ? "#3DFF6B" : "#FFFFFF",
                      WebkitTextStroke: `${3 * scale}px #000`,
                      paintOrder: "stroke fill",
                      textShadow: `0 ${4 * scale}px 0 #000, 0 ${6 * scale}px ${14 * scale}px rgba(0,0,0,0.6)`,
                      transform: on ? "scale(1.06)" : "none",
                    }}
                  >
                    {strip(w.text)}
                  </span>
                );
              })}
            </div>
          ) : (
            <div style={{ background: "rgba(0,0,0,0.55)", borderRadius: 10 * scale, padding: `${14 * scale}px ${26 * scale}px`, maxWidth: "100%", textAlign: "center" }}>
              <span style={{ fontFamily: inter.fontFamily, fontWeight: 700, fontSize: 44 * scale, lineHeight: 1.25, color: "#FFFFFF" }}>{page.words.map((w) => w.text).join(" ")}</span>
            </div>
          )}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
