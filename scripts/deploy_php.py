"""Upload reviewed PHP sources atomically, retaining previous files outside the webroot."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import posixpath
import shlex
from remote_ssh import connect, execute

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true', help='Perform the displayed deployment plan')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
webroot = '/www/wwwroot/ai.haowucm.cn'
files = ['lib.php', 'api.php', 'pub.php', 'index.php']
print('PHP deployment:', ', '.join(files), '->', webroot)
print('Existing catalog, administrator settings and release metadata are preserved.')
if not args.apply:
    raise SystemExit('Review the files, then run with --apply to deploy.')
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = '/www/aurora-backups/' + stamp
stage = backup + '/staged'
with connect() as client:
    execute(client, f'mkdir -p {shlex.quote(stage)} && chmod 700 /www/aurora-backups {shlex.quote(backup)} {shlex.quote(stage)}')
    with client.open_sftp() as sftp:
        for name in files:
            sftp.put(str(root / 'server' / name), posixpath.join(stage, name))
            execute(client, 'php -l ' + shlex.quote(posixpath.join(stage, name)))
        # All files pass syntax checks before replacing any live file.
        for name in files:
            target = posixpath.join(webroot, name)
            execute(client, f'if [ -f {shlex.quote(target)} ]; then cp -p {shlex.quote(target)} {shlex.quote(posixpath.join(backup, name))}; fi')
            sftp.chmod(posixpath.join(stage, name), 0o644)
            sftp.posix_rename(posixpath.join(stage, name), target)
            print('Deployed', name)
print('Previous files retained at', backup)
