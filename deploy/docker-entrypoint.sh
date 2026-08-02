#!/bin/sh
# Make /data writable, then stop being root.
#
# A volume on Fly, Railway or plain Docker arrives owned by root, and the image
# runs as the unprivileged `node` user. So this starts as root, hands /data over
# once, and drops. If the platform already starts the container as somebody
# else, it does nothing at all and gets out of the way.
set -e

DATA_DIR="${COL_DATA_DIR:-/data}"
APP_UID=1000
APP_GID=1000

if [ "$(id -u)" = "0" ]; then
	mkdir -p "$DATA_DIR" 2>/dev/null || true

	# Only when it is not already ours: `chown -R` over a directory holding a
	# family's photographs and a few finished videos is not a thing to do on
	# every restart.
	owner="$(stat -c %u "$DATA_DIR" 2>/dev/null || echo "$APP_UID")"
	if [ "$owner" != "$APP_UID" ]; then
		echo "[entrypoint] taking ownership of $DATA_DIR (this happens once)" >&2
		chown -R "$APP_UID:$APP_GID" "$DATA_DIR" || true
	fi

	if command -v setpriv >/dev/null 2>&1; then
		# setpriv keeps the environment as it is, and root's HOME is /root —
		# which the app user cannot write. Chromium wants a home directory.
		HOME=/home/node
		export HOME
		exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups -- "$@"
	fi

	# util-linux is part of every Debian base, so this should not happen. If it
	# does, running is better than not running — say so and carry on as root.
	echo "[entrypoint] setpriv is missing, so this stays root." >&2
fi

exec "$@"
