#!/usr/bin/python3
"""Atomic online SQLite backup, including the matching provisioning key."""
import datetime
import os
import pathlib
import shutil
import sqlite3

os.umask(0o077)
source = pathlib.Path('/var/lib/jimeng-credit-manager')
parent = pathlib.Path('/var/backups/jimeng-credit-manager')
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
target = parent / stamp
target.mkdir(parents=True, mode=0o700)
with sqlite3.connect(f'file:{source / "credits.sqlite"}?mode=ro', uri=True) as src:
    with sqlite3.connect(target / 'credits.sqlite') as dst:
        src.backup(dst)
        assert dst.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not dst.execute('PRAGMA foreign_key_check').fetchall()
shutil.copyfile(source / 'admin-secret', target / 'admin-secret')
os.chmod(target / 'admin-secret', 0o600)
os.chmod(target / 'credits.sqlite', 0o600)
(target / 'complete').touch(mode=0o600)
# Keep the last 30 days. Restrict pruning to complete snapshots made by this script.
cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
for entry in parent.iterdir():
    if entry == target or entry.is_symlink() or not entry.is_dir():
        continue
    try:
        date = datetime.datetime.strptime(entry.name, '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        continue
    if date < cutoff and (entry / 'complete').exists():
        shutil.rmtree(entry)
print(f'Backup verified: {stamp}')
