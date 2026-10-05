#!/usr/bin/env python3
"""Backup externo cifrado (AES-256-GCM) a partir de cloud_backup.py; nunca escribe la clave en un artefacto.

  create  --output RUTA.ikisai [--skip-unchanged]   crea el zip, lo cifra con IKISAI_BACKUP_KEY (32 bytes en base64),
                                                    verifica el descifrado y la integridad; con --skip-unchanged omite
                                                    la creación si el último artefacto de GitHub tiene la misma huella
  decrypt --source RUTA.ikisai --output RUTA.zip    descifra y valida el zip resultante

Requiere `cryptography` (scripts/requirements-backup.txt).
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cloud_backup import backup, validate
from cloud_management import NoRedirect, SupabaseManagement, run_cli

MAGIC = b'IkisaiAppsEncryptedBackup-v1\n'
ARTIFACT_PREFIX = 'encrypted-IkisaiApps-'


def aesgcm():
  try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
  except ImportError:
    raise ValueError('cryptography is required: pip install -r scripts/requirements-backup.txt') from None
  return AESGCM


def key():
  raw = base64.b64decode(os.environ.get('IKISAI_BACKUP_KEY', '').strip(), validate=True)
  if len(raw) != 32:
    raise ValueError('IKISAI_BACKUP_KEY must encode 32 bytes')
  return raw


def encrypt(blob, secret):
  nonce = os.urandom(12)
  return MAGIC + nonce + aesgcm()(secret).encrypt(nonce, blob, MAGIC)


def decrypt(blob, secret):
  if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + 28:
    raise ValueError('Unknown encrypted backup')
  offset = len(MAGIC)
  return aesgcm()(secret).decrypt(blob[offset:offset + 12], blob[offset + 12:], MAGIC)


def fingerprint(manifest, secret):
  """Huella con clave sobre el manifiesto sin la fecha: los artefactos no exponen ni datos ni hashes en claro."""
  stable = {k: v for k, v in manifest.items() if k != 'createdAt'}
  raw = json.dumps(stable, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
  return hmac.new(secret, raw, hashlib.sha256).hexdigest()


def recent_artifacts():
  repository = os.environ.get('GITHUB_REPOSITORY', '')
  token = os.environ.get('GITHUB_TOKEN', '')
  if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not token:
    raise ValueError('GitHub artifact access is required')
  opener = urllib.request.build_opener(NoRedirect())
  artifacts = []
  for page in range(1, 101):
    req = urllib.request.Request(f'https://api.github.com/repos/{repository}/actions/artifacts?per_page=100&page={page}', headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    with opener.open(req, timeout=45) as response:
      data = json.load(response)
    batch = data['artifacts']
    artifacts.extend(a for a in batch if a['name'].startswith(ARTIFACT_PREFIX) and not a.get('expired') and (a.get('workflow_run') or {}).get('head_branch') == 'main')
    if len(batch) < 100:
      return artifacts
  raise ValueError('Artifact inventory incomplete; cannot safely deduplicate')


def unchanged(finger, artifacts, at=None):
  at = at or datetime.now(timezone.utc)
  candidates = [a for a in artifacts if not a.get('expired') and a.get('name', '').startswith(ARTIFACT_PREFIX)]
  if not candidates:
    return False
  latest = max(candidates, key=lambda a: a['created_at'])
  match = re.fullmatch(re.escape(ARTIFACT_PREFIX) + r'([0-9a-f]{64})-[0-9]+', latest['name'])
  if not match or not hmac.compare_digest(match[1], finger):
    return False
  created = datetime.fromisoformat(latest['created_at'].replace('Z', '+00:00'))
  expires = datetime.fromisoformat(latest['expires_at'].replace('Z', '+00:00'))
  return timedelta(0) <= at - created < timedelta(days=30) and expires > at + timedelta(days=7)


def create(destination, skip_unchanged=False, credentials=None):
  secret = key()
  aesgcm()
  destination = Path(destination)
  if destination.exists():
    raise ValueError('Destination exists')
  client = SupabaseManagement(credentials)
  with tempfile.TemporaryDirectory() as temporary:
    source = Path(temporary) / 'backup.zip'
    report = backup(client, source)
    manifest = validate(source)
    finger = fingerprint(manifest, secret)
    if skip_unchanged and unchanged(finger, recent_artifacts()):
      return {'status': 'SKIPPED', 'reason': 'unchanged', 'created': False, 'fingerprint': finger}
    blob = source.read_bytes()
    sealed = encrypt(blob, secret)
    if decrypt(sealed, secret) != blob:
      raise ValueError('Encryption round trip failed')
    restored = Path(temporary) / 'verified.zip'
    restored.write_bytes(decrypt(sealed, secret))
    validate(restored)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('xb') as out:
      out.write(sealed)
    try:
      destination.chmod(0o600)
    except OSError:
      pass
  report.pop('output', None)
  return {**report, 'output': str(destination), 'created': True, 'fingerprint': finger, 'encrypted': True, 'decryptAndIntegrityVerified': True}


def decrypt_file(source, output):
  output = Path(output)
  if output.exists():
    raise ValueError('Destination exists')
  blob = decrypt(Path(source).read_bytes(), key())
  with output.open('xb') as stream:
    stream.write(blob)
  try:
    output.chmod(0o600)
  except OSError:
    pass
  try:
    validate(output)
  except BaseException:
    output.unlink(missing_ok=True)
    raise
  return {'status': 'PASS', 'decryptedAndIntegrityVerified': True, 'output': str(output)}


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  sub = parser.add_subparsers(dest='command', required=True)
  c = sub.add_parser('create')
  c.add_argument('--output', required=True)
  c.add_argument('--skip-unchanged', action='store_true')
  c.add_argument('--credentials')
  d = sub.add_parser('decrypt')
  d.add_argument('--source', required=True)
  d.add_argument('--output', required=True)
  args = parser.parse_args()

  def action():
    if args.command == 'create':
      result = create(args.output, args.skip_unchanged, args.credentials)
      if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
          stream.write('created=' + str(result['created']).lower() + '\nfingerprint=' + result['fingerprint'] + '\n')
      return result
    return decrypt_file(args.source, args.output)

  try:
    run_cli(action)
  except Exception:  # cualquier fallo criptográfico o de archivo: nunca se imprime el detalle
    print(json.dumps({'status': 'invalid_backup_key_or_archive'}))
    raise SystemExit(1)
