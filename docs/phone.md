# Atlas on your iPhone (Tailscale)

Atlas keeps running on your Mac, exactly as now (`npm run atlas`, `.env`
on the Mac). Tailscale gives the Mac a private HTTPS address that only your
own devices can open, so the iPhone can use the page, voice included.

Nothing is opened to the internet: no router port, and Atlas still listens
on `127.0.0.1` only. Tailscale Serve (not Funnel) passes requests from your
tailnet to it. It works whenever the Mac is awake and Atlas is running.

## One-time setup

1. **Install Tailscale** on the Mac (tailscale.com/download, or the Mac App
   Store) and on the iPhone (App Store). Sign in to both with the same
   account. In the iPhone app, leave **Use Tailscale DNS** on.
2. **Name the Mac sensibly.** HTTPS certificates are public records, so the
   Mac's name and your tailnet name end up in public certificate logs. In
   the Tailscale admin console (Machines), rename it if its name says more
   than you'd like (for example to `atlas-mac`).
3. **Serve Atlas over HTTPS.** In a terminal on the Mac:

   ```sh
   tailscale serve --bg http://127.0.0.1:8080
   ```

   The first time, Tailscale says Serve or HTTPS isn't enabled and prints a
   link: open it, enable both, and run the command again. It then prints
   the address, like `https://atlas-mac.tail1234.ts.net`. If `tailscale`
   isn't found, the App Store version's CLI is at
   `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
4. **Let Atlas accept that name.** Add it to `.env` on the Mac, the name
   only (no `https://`):

   ```sh
   ALLOWED_HOSTS=atlas-mac.tail1234.ts.net
   ```

   Then restart Atlas. Without this, the page answers "This server only
   accepts requests to localhost" (403): the Host guard still blocks every
   name it wasn't told about.
5. **Open it on the iPhone** in Safari, with Tailscale connected:
   `https://atlas-mac.tail1234.ts.net`. Allow the microphone when asked.
   Share → **Add to Home Screen** makes it an app icon.

## Check it's private

- On the iPhone, turn Wi-Fi off (mobile data), open the address, and ask
  something by voice: it should answer.
- Turn Tailscale off on the iPhone (or try from a device that isn't in your
  tailnet): the address shouldn't open.
- On the Mac, `tailscale serve status` shows the one address, and
  `tailscale funnel status` shows that Funnel is off.

## Keep the Mac awake

The phone reaches Atlas only while the Mac is awake. On power: System
Settings → Battery (or Energy) → Options → **Prevent automatic sleeping
when the display is off**. Or, for one session, run `caffeinate -s` in a
terminal while Atlas runs.

## Stop

`tailscale serve reset` takes the address away; remove `ALLOWED_HOSTS` from
`.env` and restart Atlas.

## If it doesn't work

- **403 "only accepts requests to localhost":** `ALLOWED_HOSTS` doesn't
  match the address exactly, or Atlas wasn't restarted.
- **502:** Atlas isn't running on the Mac, or not on port 8080 (use the
  same port in `tailscale serve`).
- **The name doesn't open on the phone:** Tailscale isn't connected there,
  or another DNS setting overrides it (iCloud Private Relay, a DNS profile):
  turn those off for the tailnet.
- **A TLS error:** use the name, not the `100.x` IP address.
