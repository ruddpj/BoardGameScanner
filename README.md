# BoardGameScanner

A board game catalog, UUID QR label maker, and shared live scan-session tracker. The site is a static app hosted on GitHub Pages; Supabase provides the shared database and live updates.

## Set up shared scanning

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql).
3. Copy the project URL and anon/public key from **Project Settings → API**.
4. For local development, copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. To publish from GitHub Actions, add repository secrets named `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with those same values.
6. In the repository settings, open **Pages** and set the build/deployment source to **GitHub Actions**.

The anon key is intended for browser use. The included schema allows anonymous public access to the games and scan sessions, so only use this project for data you are comfortable making public. Do not put a Supabase service-role key in the app or GitHub Actions secrets.

Without Supabase configuration, the catalog is stored locally in the current browser and QR labels still work; shared sessions are disabled.

## Use

- Add games one at a time or paste a list, one game per line.
- Open **QR labels** to generate an individual label or every label in the catalog; use **Print labels** for a printable sheet.
- Create a scan session and share its four-letter join code. Other players open the same site, enter the code, and choose a player name.
- Scan a label with the device camera, or paste a UUID into the manual scan field. The session updates live and shows scanned and remaining games.

QR codes contain the game's UUID, not its name, so labels remain unique even when games have similar names.

## Development

```sh
npm install
npm run dev
npm run build
```
