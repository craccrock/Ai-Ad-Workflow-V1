import React from "react";
import { Composition } from "remotion";
import { Captions, type CaptionsProps } from "./Captions";

/** One composition; the server passes the real size, length and words as input props per render. */
export const Root: React.FC = () => (
  <Composition
    id="captions"
    component={Captions}
    durationInFrames={30 * 10}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ src: "", words: [], preset: "capcut" } satisfies CaptionsProps}
  />
);
