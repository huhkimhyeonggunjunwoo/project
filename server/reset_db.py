"""Deletes the database for the current APP_ENV, so the server starts empty.

    npm run server:reset                          # development: deletes right away
    APP_ENV=production npm run server:reset       # production: asks to confirm first

Restart the server afterwards if it's running: it keeps the old file open.
Browsers' saved tokens stop matching anyone, so they just get new anonymous
users on their next visit.
"""

import sys

from config import settings


def main() -> int:
    path = settings.database_file
    files = [path, path.with_name(f"{path.name}-wal"), path.with_name(f"{path.name}-shm")]
    existing = [f for f in files if f.exists()]
    if not existing:
        print(f"Nothing to reset: {path} doesn't exist.")
        return 0

    print(f"Resetting the {settings.app_env} database: {path}")
    if settings.app_env == "production" and "--yes" not in sys.argv[1:]:
        if input("This deletes all production users and messages. Type 'reset' to continue: ").strip() != "reset":
            print("Cancelled.")
            return 1

    for f in existing:
        f.unlink()
    print("Done. Restart the server if it's running.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
