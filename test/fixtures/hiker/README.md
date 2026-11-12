# HikerAPI fixtures

**These are not live captures.** No API key was available when the backend was
written. Every file here is built from the provider's published documentation,
with one exception noted below. Until the checks at the end of this file have
been run with a real key, treat the hiker backend as unverified against
production.

## Sources

| Short name | What | Where |
|---|---|---|
| OpenAPI | `openapi.json` in this directory, version 1.8.3, downloaded 2026-11-11 | https://api.hikerapi.com/openapi.json |
| Handbook | Per-endpoint pages with full example responses | https://hiker-doc.readthedocs.io/en/latest/api-reference/ |
| Response codes | Status codes and which ones are billed | https://hiker-doc.readthedocs.io/en/latest/api-reference/response-codes/ |
| Request costs | Requests charged per endpoint | https://hiker-doc.readthedocs.io/en/latest/guides/request-costs/ |
| instagrapi | Same maintainer's Python library; used only for "largest video rendition wins" | `subzeroid/instagrapi`, `instagrapi/extractors.py` |

## Files

| File | Built from | Edited how |
|---|---|---|
| `openapi.json` | OpenAPI | Verbatim download |
| `error-401.json` | **Live**: the body the API returns with no key or an invalid key (HTTP 401, not billed) | Verbatim |
| `balance.json` | Handbook, `/sys/balance` example | Verbatim |
| `user-by-username.json` | Handbook, `/v1/user/by/username` example | Verbatim |
| `user-by-username-private.json` | OpenAPI `User` schema | Invented values: private, follower count null, empty strings |
| `media-by-code.json` | Handbook, `/v1/media/by/code` example | Verbatim |
| `clips-chunk-page1.json`, `-page2.json` | Handbook, `/v1/user/clips/chunk` example | One item verbatim (trimmed); the others invented on the `Media` schema: a pinned old reel, a photo, hidden counts, dates either side of a year and a month boundary |
| `fbsearch-accounts-page1.json`, `-page2.json` | Handbook, `/v2/fbsearch/accounts` example | Page 1 trimmed; page 2 invented on the same shape: a repeated account, a private one, a user with no follower text |
| `fbsearch-reels-page1.json`, `-page2.json` | Handbook, `/v2/fbsearch/reels` example | First clip trimmed from about 330 fields to the ones read; the rest invented on the same shape. The media `pk` is deliberately a 19-digit JSON number, as upstream sends it |
| `hashtag-medias-page1.json`, `-page2.json` | OpenAPI, `/g2/hashtag/medias` example (the provider's own synthetic data) | Elided `"..."` members removed; a reel without `play_count` and a second page invented |
| `suggested-profiles.json` | Handbook, `/v2/user/suggested/profiles` example | Verbatim |

## Endpoint choices

| Method | Endpoint | Why this one | Response shape |
|---|---|---|---|
| `login` | `GET /sys/balance` | Documented as free and not billed; proves the key and reports remaining requests | Verified: OpenAPI `Balance` schema |
| `getProfile` | `GET /v1/user/by/username` | Typed `User` schema with every field needed. `/v2/user/by/username` is an untyped pass-through whose count fields are elided in its example | Verified: OpenAPI `User` schema and Handbook example |
| `listReels` | `GET /v1/user/clips/chunk` | Typed `Media` items with a ready `video_url`. `/g2/user/clips` is documented as possibly lacking video data; `/v2/user/clips` and `/gql/user/clips` are untyped | Verified: OpenAPI (`[Media[], cursor \| null]`) and Handbook example |
| `getVideo` | `GET /v1/media/by/code` | Typed `Media`. Also the one the docs recommend when `/v2/media/info/by/code` returns 404 for promoted posts | Verified: OpenAPI `Media` schema and Handbook example |
| `searchCreators` | `GET /v2/fbsearch/accounts` | The current account search; `/v1/search/users` and `/v2/search/accounts` are marked for deprecation | Verified: Handbook example. No schema in OpenAPI |
| `searchReels` | `GET /v2/fbsearch/reels` | The only non-deprecated reel search; `/v3/fbsearch/reels` is deprecated for returning duplicates | Verified: Handbook example. No schema in OpenAPI |
| `hashtagReels` | `GET /g2/hashtag/medias` | Every other hashtag media endpoint is marked "Gone" and points here | Partly verified: OpenAPI example, which elides most fields. **Inferred**: `video_versions[].url` and the thumbnail path `image_versions2.candidates[].url` (same raw media shape as the reel search example) |
| `relatedCreators` | `GET /v2/user/suggested/profiles` | `/gql/user/related/profiles` is deprecated in its favour | Verified: Handbook example. No schema in OpenAPI (`{}`) |

Requests per call: one for `login`, `getProfile`, `getVideo` and
`relatedCreators`; one per page for the others, stopping at `limit`. All eight
endpoints are listed at 1 request each (none is in the multi-request table).

## Sound (`Video.audio`)

No fixture file carries a sound: none of the handbook examples for the four media
endpoints used here includes one. The normalizer reads it from what is documented:

| Read | Documented where |
|---|---|
| `Media.clips_metadata`, a free-form object | OpenAPI `Media` schema (typed endpoints: `/v1/user/clips/chunk`, `/v1/media/by/code`) |
| `music_metadata` on raw media | Handbook examples of `/v2/fbsearch/topsearch`, `/v2/hashtag/medias/*`, `/v2/user/tag/medias`; it is `null` on every reel of the `/v2/fbsearch/reels` example |
| inside either: `music_info.music_asset_info.{audio_cluster_id, audio_asset_id, id, title, display_artist}` | Same handbook examples |
| inside either: `original_sound_info.{audio_asset_id, original_audio_title, ig_artist.username}` | `ClipsMetadata` and `ClipsOriginalSoundInfo` in the same maintainer's `instagrapi/types.py`. Always `null` in the handbook examples |

The same two inner shapes were captured live from Instagram's web app (see
`../browser/README.md`), which is what the provider passes through. **Not verified
with a real key**: that `clips_metadata` is filled on the typed endpoints, and with
these inner names. Until then a hiker video simply has no `audio`.

The tests in `test/hiker-audio.test.ts` use inline objects built on those shapes.

## Inferred, not documented anywhere

- That `/v1/user/clips/chunk` returns pinned reels first. The backend sorts by date either way.
- What a hidden like count looks like. The backend treats a like count of 0 with `like_and_view_counts_disabled: true`, or any negative count, as hidden (null).
- That `/v1/user/clips/chunk` accepts the cursor it returned as `end_cursor` (the parameter and the cursor are documented; the round trip is not shown).
- What a search with no results returns (an empty list, or 404).
- The body of every error other than 401.
- Whether the typed `Media.comment_count`, whose schema default is 0, is 0 or null when Instagram omits it. A 0 from this endpoint is passed through as 0.

## Check with a real key, in this order

1. `ig auth login hiker`: key accepted, balance line printed, and the balance did not drop.
2. `getProfile` on a large public account: follower, following and media counts match the app.
3. `getProfile` on a name that does not exist: HTTP 404, mapped to NOT_FOUND.
4. `listReels` with a limit above one page (for example 30): the cursor round trip works, items are videos, `video_url` is present and downloads.
5. `getVideo` on a reel, then on a photo post: the first has a playable URL, the second is refused as "not a video".
6. `searchCreators`: `search_social_context` still reads "N followers"; page two via `page_token` returns new accounts.
7. `searchReels` with a limit above one page: `reels_max_id` plus `rank_token` returns a new page, not the first one again.
8. `hashtagReels`: confirm the two inferred paths (video URL, thumbnail) and how many pages a limit of 20 costs given the mix of photos.
9. `relatedCreators` on a public account, then on a private one (expect 403, mapped to NOT_FOUND "private").
10. A reel whose owner hides like counts: confirm what `like_count` holds.
11. `listReels` on a creator who uses licensed music and on one who uses their own sound: `clips_metadata` is present and `Video.audio` is filled for both.
12. Compare the `x-hiker-info` response header (`{"reqs": n}`) with one request per call on each endpoint above.

Replace the files here with real captures as each step passes.
