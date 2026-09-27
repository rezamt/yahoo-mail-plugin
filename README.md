# yahoo-mail-plugin

A Claude Code plugin that lets Claude read, search and send email from a Yahoo
Mail account over IMAP/SMTP, using a Yahoo App Password. Sending always
requires your explicit confirmation.

> **Status:** in design. Requirements and architecture are being written in
> [yahoo-mail-plugin-spec](https://github.com/rezamt/yahoo-mail-plugin-spec).

> **Contributing?** Give
> [BOOTSTRAP.md](https://github.com/rezamt/yahoo-mail-plugin-spec/blob/main/BOOTSTRAP.md)
> to Claude Code and say *"read BOOTSTRAP.md and set up my environment"*.

## Setup

The server reads two required environment variables once at startup and never logs them:

- `YAHOO_ACCOUNT_EMAIL` — your Yahoo account address
- `YAHOO_APP_PASSWORD` — a Yahoo App Password (2FA-based; not your regular account password)

## License

MIT — see [LICENSE](LICENSE).
