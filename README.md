# World Feed

Rolling news feed for weather events, festivals, artists, actors and film production.

## Setup
1. Create a **public** GitHub repo and upload everything in this folder (keep the `.github` folder).
2. Settings > Pages > deploy from branch `main`, folder `/ (root)`.
3. Actions tab > "Update feed" > Run workflow. This creates `feed.json`.
4. Open `https://<you>.github.io/<repo>/` on the TV.

## Customise
Edit `config.json`: watchlists (artists, actors, festivals, films), RSS feeds, search queries,
how old items can be, and how many appear. Text-only edits, no code needed.

## Notes
- Each source fails independently; if everything fails, the old feed.json stays in place.
- Scheduled workflows can be paused by GitHub after long repo inactivity; re-enable from the Actions tab.
- Check feed URLs occasionally, as publishers change them. The Actions log shows ok/FAIL per source.
- Test locally with: node scripts/fetch-feed.mjs
