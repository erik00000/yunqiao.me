"""Shared SSH connection. Credentials stay in the terminal environment."""
import base64
import getpass
import hashlib
import os
from pathlib import Path
import sys
import paramiko

HOST = os.environ.get('AURORA_SSH_HOST', '58.49.150.136')
PORT = int(os.environ.get('AURORA_SSH_PORT', '4413'))
USER = os.environ.get('AURORA_SSH_USER', 'root')

class PinnedHost(paramiko.MissingHostKeyPolicy):
    def missing_host_key(self, client, hostname, key):
        file = Path(__file__).with_name('ssh-host-fingerprint.txt')
        expected = os.environ.get('AURORA_SSH_FINGERPRINT') or (file.read_text().strip() if file.exists() else '')
        actual = 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
        if not expected or expected != actual:
            raise paramiko.SSHException('SSH host fingerprint mismatch. Verify the server and set AURORA_SSH_FINGERPRINT.')

def connect():
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(PinnedHost())
    password = os.environ.get('AURORA_SSH_PASSWORD')
    if not password and sys.stdin.isatty():
        password = getpass.getpass('SSH password (not saved): ')
    client.connect(HOST, port=PORT, username=USER, password=password, timeout=20, auth_timeout=20)
    return client

def execute(client, command):
    _, output, errors = client.exec_command(command, timeout=60)
    text = output.read().decode('utf-8', 'replace')
    error = errors.read().decode('utf-8', 'replace')
    code = output.channel.recv_exit_status()
    if code:
        raise RuntimeError(error or text or f'Remote command failed ({code})')
    return text

def run(commands):
    with connect() as client:
        return '\n'.join(execute(client, command) for command in commands)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python scripts/remote_ssh.py "read-only command"')
    print(run(sys.argv[1:]))
