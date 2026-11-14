"""Upload only this package version. Does not publish update metadata automatically."""
import argparse
import hashlib
import json
from pathlib import Path
from remote_ssh import connect, execute

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
files = sorted((root / 'release').glob(f'YunQiaoAI-{version}-win-x64-*.exe'))
if len(files) != 2:
    raise SystemExit('Build both Windows installers first: npm run package:win')
for file in files:
    print(file.name, 'SHA256', hashlib.sha256(file.read_bytes()).hexdigest())
if not args.apply:
    raise SystemExit('Review artifacts, then run with --apply to upload.')
remote = '/www/wwwroot/ai.haowucm.cn/releases'
with connect() as client:
    execute(client, 'mkdir -p ' + remote)
    with client.open_sftp() as sftp:
        for file in files:
            target = remote + '/' + file.name
            try:
                sftp.stat(target)
                raise RuntimeError('Release already exists; increment the version before uploading: ' + file.name)
            except FileNotFoundError:
                pass
            sftp.put(str(file), target + '.uploading', confirm=True)
            sftp.chmod(target + '.uploading', 0o644)
            sftp.posix_rename(target + '.uploading', target)
            print('Uploaded', file.name)
print('Upload complete. Publish reviewed version metadata separately in the admin panel.')
