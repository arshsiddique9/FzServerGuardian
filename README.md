# FzServerGuardian

Browser-UI-based monitoring and recovery for three Pterodactyl servers:
Survival, Lifesteal and Practice.

**Owner:** Flick ZZ (Arsh)

## Important limitations

- This project does not call the Pterodactyl API. It uses Playwright to sign in and interact with the panel's visible UI.
- The Pterodactyl UI differs between panel versions/themes. The default selectors are common defaults, not guaranteed. If the panel does not expose recognizable Start/Stop buttons, adjust `config/servers.json`.
- GitHub Actions is scheduled automation, not a permanently running process. The workflow runs every 5 minutes when GitHub schedules it; runs can be delayed. It is not suitable for guaranteed instant recovery.
- Scheduled GitHub Actions workflows must be on the repository's default branch. Public repositories have free standard GitHub-hosted runners under GitHub's current policy; check current GitHub plan limits before relying on this.
- DDoS cannot be conclusively diagnosed from a failed Minecraft connection. The bot reports network disruption as suspected, not confirmed. It waits when panel text indicates node/daemon/gateway unavailability.
- CAPTCHA, MFA, bot challenges, or provider restrictions may require a human and are not bypassed.
- This starter is deliberately conservative. Test it with automatic clicking disabled or with a test server before enabling it on production servers.

## 1. Create a GitHub repository

1. Sign in to GitHub.
2. Create a **public** repository named `FzServerGuardian` if you want to use free standard runners.
3. Upload all project files and folders from this ZIP.
4. Make sure `.github/workflows/guardian.yml` is included.
5. Keep the repository on its default branch (usually `main`).

Do not upload your `.env`, passwords, Discord webhook, browser profile, or session cookies.

## 2. Configure the three server page URLs

Open `config/servers.json`.

Replace the three `serverPageUrl` values with the exact browser URLs for the Survival, Lifesteal and Practice server pages. Example format:

`https://your-panel-domain/server/your-server-identifier`

Set the correct Minecraft host and port for each server too. Do not guess ports; copy them from your hosting panel.

If all three servers are on the same known node, set the same meaningful `nodeGroup` value for all three. If you do not know the node, leave `unknown`.

## 3. Add GitHub Actions Secrets

Repository → Settings → Secrets and variables → Actions → New repository secret.

Create these secrets:

| Secret name | Value |
|---|---|
| `PANEL_URL` | Pterodactyl panel base URL, e.g. `https://panel.example.com` |
| `PANEL_USERNAME` | Panel login email/username |
| `PANEL_PASSWORD` | Panel password |
| `DISCORD_WEBHOOK_URL` | Discord channel webhook URL |

Use an account you are authorized to automate. Do not share these values with anyone.

## 4. Check UI selectors

The defaults in `config/servers.json` are:

- Username: `input[name='email']`
- Password: `input[name='password']`
- Login button: `button[type='submit']`
- Start button: accessible button name `Start`
- Stop button: accessible button name `Stop`

If your panel uses different labels or markup, update the selectors. The bot fails safely if it cannot identify a Start/Stop control.

## 5. Run it

1. Open the repository's **Actions** tab.
2. Select **FzServerGuardian**.
3. Click **Run workflow**.
4. Open the run and inspect its logs.
5. Confirm that login succeeds and all three servers are classified correctly.

After that, GitHub will schedule it every five minutes. Scheduled workflows may be delayed.

## 6. First-run safety recommendation

For the first test, use a non-production test server if possible. Confirm that the panel login, page URLs and Start/Stop detection work before relying on automatic recovery.

The bot only clicks Start after two consecutive checks show the Start control. It has a one-hour per-server cooldown. A click is not treated as proof that Minecraft is online; the panel state and subsequent TCP check are separate signals.

## Troubleshooting

### Login fails
Check the panel URL and credentials. If the provider requires CAPTCHA/MFA, complete the required verification manually or ask the provider for an approved automation method. Do not attempt to bypass it.

### Start/Stop buttons not found
Your panel's UI may use different accessible labels. Update `startButtonText` and `stopButtonText` in `config/servers.json` to match the actual button names.

### Server page URL invalid
Open each server in your browser and copy its full page URL. Paste it into the matching server's `serverPageUrl`.

### Chromium fails to install or launch
Check the failed GitHub Actions step. GitHub-hosted Ubuntu runners normally support Playwright Chromium, but runner images and dependencies can change.

### Node/DDoS diagnosis
A panel message indicating node/daemon/gateway failure causes the bot to wait. A failed Minecraft TCP check while the panel indicates running is reported as network unreachable / possible disruption, not confirmed DDoS.

## Files

- `config/servers.json` — server URLs, ports and UI selectors.
- `src/guardian.js` — browser login, monitoring, recovery and notifications.
- `src/index.js` — entry point.
- `.github/workflows/guardian.yml` — five-minute scheduled GitHub workflow.
- `state/guardian-state.json` — cooldown state restored/saved using GitHub Actions cache.

## License

Personal project for Flick ZZ (Arsh).
