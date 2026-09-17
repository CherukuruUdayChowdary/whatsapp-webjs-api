# PHP dashboard (Hostinger)

Password-protected test dashboard for the WhatsApp Web.js API, with one login per WhatsApp number plus an admin login.

## Files

| File | Upload to |
|---|---|
| `dashboard.php` | `public_html/wa/dashboard.php` |
| `cron.php` | `public_html/wa/cron.php` |
| `config.example.php` | `public_html/wa/config.php` (rename, then fill in) |
| `data/.htaccess` | `public_html/wa/data/.htaccess` |
| `root-index.php` | `public_html/index.php` (optional redirect) |

## Setup

1. Copy `config.example.php` to `config.php` and set `API_URL` (tunnel or server address), `API_KEY`, `ADMIN_PASSWORD` and one password per number in `ACCOUNT_PASSWORDS`.
2. Add a Hostinger cron job (every 1–5 minutes):
   `/usr/bin/php /home/<user>/domains/<site>/public_html/wa/cron.php`
3. Open `/wa/dashboard.php` and log in as `admin` or as a number's name.

## Logins

- `admin` – all numbers: switch, add (QR), restart, log out, delete, all scheduled messages.
- `<number name>` – only that number and its own scheduled messages.
- Sessions end when the browser closes, after 15 minutes idle, or when that login's password changes.

**Never commit `config.php`** – it holds the real API key and passwords.
