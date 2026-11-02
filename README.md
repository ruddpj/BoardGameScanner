# BoardGameScanner

A board game catalog, UUID QR label maker, and shared live scan-session tracker. The site is a static app hosted on GitHub Pages; Supabase provides the shared database and live updates.

## Set up shared scanning

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql). Re-run it for an existing installation to add the game copy-count and saved-session columns and enable the access policies. Existing games default to one copy.
3. Copy the **Project URL** and anon/public key from **Project Settings → API**. Use the project URL by itself (for example, `https://your-project.supabase.co`), not the dashboard URL or a URL ending in `/rest/v1`. The app also strips a trailing `/rest/v1` if it was included accidentally.
4. For local development, copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. To publish from GitHub Actions, add repository secrets named `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with those same values.
6. In the repository settings, open **Pages** and set the build/deployment source to **GitHub Actions**.

In **Authentication → Users**, create an account for each collection manager. Disable public sign-ups in **Authentication → Settings** so visitors cannot create manager accounts.

**Access control is not active until you run the schema in step 2.** The app's sign-in screen is not a substitute for Supabase row-level security.

The anon key is intended for browser use. The schema allows visitors to read the game list and session codes and add scans to active sessions; only authenticated users can add, edit, or remove games, create or finish sessions, or delete finished sessions. These restrictions are enforced by Supabase row-level security, not just by hiding app controls. Do not put a Supabase service-role key in the app or GitHub Actions secrets.

Without Supabase configuration, the catalog is stored locally in the current browser and QR labels still work; shared sessions are disabled.

## Use

- Add games one at a time or paste a list, one game per line.
- Sign in with a manager account to add, edit, or remove games and to create or finish scan sessions. Guests can still join a session and scan games without an account.
- Each game starts with one copy. Change a game's copy count in its collection row and save it; counts are shared across devices and shown in scan lists.
- Open **QR codes** to generate an individual label or every label in the catalog; use **Print** for a printable sheet.
- Create a scan session and share its four-letter join code. Other players open the same site and enter the code.
- Point the device camera at a label to scan continuously. When a known QR is detected, the preview freezes and highlights it; tap the green **Add [game]** button to log one copy, then scan again for another. You can also paste a UUID into the manual scan field. The scanner uses QR-focused, try-harder decoding and requests up to 4K resolution and continuous autofocus where the browser and device support those controls.
- The session updates live with the number of copies logged and the listed copies still unscanned.
- Select **Finish session** when scanning is finished. Saved sessions can be reopened from **Past sessions**; signed-in managers can change saved-session scan counts, add or remove games, and delete saved sessions.

QR codes contain the game's UUID, not its name, so labels remain unique even when games have similar names.

## Development

```sh
npm install
npm run dev
npm run build
```
