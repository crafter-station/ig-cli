# Browser backend fixtures

Live captures of the GraphQL responses Instagram's web app loaded for itself on 2026-11-11, while logged in, trimmed for size.

Removed before committing: everything describing the logged-in viewer (`xdt_viewer`, `viewer`, `friendship_status`, social-context snippets), tracking tokens, comment previews, and the signature query string of every CDN URL. The one search entry whose snippet named an account the viewer follows was replaced with a synthetic string.

| File | Operation (`x-fb-friendly-name`) | Triggered by |
|---|---|---|
| `profile.json` | `PolarisProfilePageContentQuery` | opening `/<username>/` |
| `timeline.json` | `PolarisProfilePostsQuery` | opening `/<username>/` |
| `related.json` | `PolarisProfileSuggestedUsersWithPreloadableQuery` | opening `/<username>/` |
| `reels.json` | `PolarisProfileReelsTabContentQuery` | opening `/<username>/reels/` |
| `reels-more.json` | `PolarisProfileReelsTabContentQuery_connection` | scrolling the reels tab |
| `account-search.json` | `PolarisSearchBoxRefetchableQuery` | typing in the search box |
| `serp.json` | `PolarisKeywordSearchExplorePageRelayQuery` | opening `/explore/search/keyword/?q=...` |
| `reel-page.json` | embedded `xdt_api__v1__media__shortcode__web_info` | opening `/reel/<code>/` |

What each surface lacks, which shapes the backend:

- The reels tab has play counts but no caption, date or video URL.
- The timeline and the reel page have caption, date and video URL but no play count.
- Keyword results have no play count.
- Account search gives the follower count only as localized text.
- A non-existent profile returns HTTP 200 and simply never fires the profile query.
- The classic `/api/v1/users/web_profile_info/` and `/api/v1/web/search/topsearch/` endpoints answered 404 from inside the logged-in page.
