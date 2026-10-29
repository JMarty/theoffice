# Troubleshooting: the fleet does not start at boot (linger)

**Status:** fixed in `scripts/install.sh` (step 5, "enable + start"). This page explains the symptom and the manual fix.

## Symptom

After the machine boots, The Office does not start by itself. The services only come up once the
engine user logs in interactively (console or SSH). On a headless boot, the dashboard, Slack ingest,
scheduler and bus are not running.

Typical sign: `systemctl --user status theoffice.service` shows an **Active since** time close to the
*login*, not to the *boot*.

## Root cause

`theoffice.service` and `theoffice-tmux.service` are systemd `--user` units. A user's systemd instance
(`user@<uid>.service`) starts at boot without a login only if **linger** is enabled for that user
(`loginctl enable-linger`). Without linger it starts at the first interactive login.

Enabling linger is a privileged action (polkit/root). In a non-interactive install, such as
`bootstrap.sh` run as `curl ... | bash` without a tty, a plain call is denied.

## What the installer does now

- tries `sudo -n` first (works with passwordless sudo), then interactive `sudo`, then a plain call;
- re-reads the `Linger` property afterwards and, if it is still `no`, prints the exact manual command loudly instead
  of continuing silently;
- is idempotent: nothing happens if linger is already `yes`.

## Manual fix

```bash
sudo loginctl enable-linger <user>
loginctl show-user <user> | grep Linger        # want: Linger=yes
```

## Verify

```bash
sudo reboot
# after the reboot, WITHOUT logging in interactively first:
systemctl --user status theoffice.service       # Active since ~ boot time, not login time
```
