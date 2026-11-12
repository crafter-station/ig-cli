// Video.audio from HikerAPI media. The shapes are documented, not captured:
// see "Sound" in test/fixtures/hiker/README.md.

import { describe, expect, it } from "vitest";
import { normalizeMedia } from "../src/backends/hiker/normalize.js";

describe("hiker audio", () => {
  const typed = {
    pk: "3838197568999826383",
    id: "3838197568999826383_787132",
    code: "DVD3abc",
    media_type: 2,
    taken_at_ts: 1771768875,
    user: { pk: "787132", username: "natgeo" },
    caption_text: "A caption",
  };
  const at = "/v1/user/clips/chunk";

  it("reads licensed music from clips_metadata", () => {
    const video = normalizeMedia(
      {
        ...typed,
        clips_metadata: {
          audio_type: "licensed_music",
          music_info: {
            music_asset_info: {
              audio_asset_id: "3223790814617058",
              audio_cluster_id: "2094289147512017",
              display_artist: "AURORA",
              id: "3223790814617058",
              title: "Runaway",
            },
          },
          original_sound_info: null,
        },
      },
      at,
    );
    expect(video?.audio).toEqual({
      id: "2094289147512017",
      title: "Runaway",
      artist: "AURORA",
      isOriginal: false,
    });
    expect(video?.caption).toBe("A caption");
  });

  it("reads a creator's own sound, with its numeric id as a string", () => {
    const video = normalizeMedia(
      {
        ...typed,
        clips_metadata: {
          audio_type: "original_sounds",
          music_info: null,
          original_sound_info: {
            audio_asset_id: 1571633047283905,
            original_audio_title: "Original audio",
            ig_artist: { username: "natgeo" },
          },
        },
      },
      at,
    );
    expect(video?.audio).toEqual({
      id: "1571633047283905",
      title: "Original audio",
      artist: "natgeo",
      isOriginal: true,
    });
  });

  it("reads the same content under music_metadata on raw media", () => {
    const video = normalizeMedia(
      {
        ...typed,
        music_metadata: {
          audio_type: "licensed_music",
          music_info: { music_asset_info: { id: "182370286170788", title: "Solitude" } },
          original_sound_info: null,
        },
      },
      "/v2/fbsearch/reels",
    );
    expect(video?.audio).toEqual({
      id: "182370286170788",
      title: "Solitude",
      artist: null,
      isOriginal: false,
    });
  });

  it("is absent when the item reports no container, null when the container is empty", () => {
    const none = normalizeMedia(typed, at);
    expect(none && "audio" in none).toBe(false);
    expect(normalizeMedia({ ...typed, clips_metadata: {} }, at)?.audio).toBeNull();
    expect(normalizeMedia({ ...typed, music_metadata: null }, at)?.audio).toBeNull();
  });
});
