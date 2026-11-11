"""Create a consistent, timestamped SQLite backup using SQLite's online backup API."""
import argparse
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="directory for the backup (defaults to the source database directory)",
    )
    args = parser.parse_args()

    source = Path(os.environ.get("CCC_DB", str(BASE / "ccc.db")))
    if not source.is_file():
        parser.error(f"database file does not exist: {source}")

    output_dir = args.output_dir or source.parent
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    destination = output_dir / f"ccc-backup-{stamp}.db"

    with closing(sqlite3.connect(str(source))) as source_db:
        with closing(sqlite3.connect(str(destination))) as backup_db:
            source_db.backup(backup_db)
    print(destination)


if __name__ == "__main__":
    main()
