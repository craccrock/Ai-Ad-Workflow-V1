/** Reason tags for a thumbs-down on a take or clip (client + server). Keep in sync with lib/learning THUMBS_DOWN_TAGS. */
export const LEARNING_TAGS = [
  { value: "hands", label: "Hands" },
  { value: "face", label: "Face / identity" },
  { value: "wrong_person", label: "Wrong person" },
  { value: "text", label: "Text / watermark" },
  { value: "motion", label: "Motion / camera" },
  { value: "setting", label: "Setting / props" },
  { value: "pace", label: "Pace / timing" },
  { value: "voice", label: "Voice / lipsync" },
  { value: "other", label: "Other" },
] as const;
export type LearningTag = (typeof LEARNING_TAGS)[number]["value"];
