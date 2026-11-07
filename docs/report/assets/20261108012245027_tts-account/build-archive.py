from pathlib import Path
import hashlib
import io
import json
import stat
import sys
import zipfile

root = Path(sys.argv[1]).resolve()
out = Path(__file__).resolve().parent
previous = root / 'docs/report/assets/20261107185825821_extension-tts-settings/BDC-extension-0.6.6.zip'
with zipfile.ZipFile(previous) as archive:
    names = sorted(set(archive.namelist()) | {'extension/modules/tts-profile-storage.js', 'extension/modules/tts-account-sync.js', 'extension/shared/tts-settings.mjs'})
assert len(names) == 74
assert (root / 'extension/ai-config.js').read_bytes() == (root / 'ai-config.example.js').read_bytes()
assert json.loads((root / 'extension/manifest.json').read_text())['version'] == '0.6.7'
for name in names:
    source = root / name
    assert name.startswith('extension/') and '..' not in Path(name).parts
    assert source.is_file() and not source.is_symlink()

def build():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, (root / name).read_bytes(), compresslevel=9)
    return buffer.getvalue()

data = build()
assert data == build()
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    assert archive.testzip() is None
    assert sorted(archive.namelist()) == names
    for name in names:
        assert archive.read(name) == (root / name).read_bytes()
archive_path = out / 'BDC-extension-0.6.7.zip'
archive_path.write_bytes(data)
manifest = {'version': '0.6.7', 'archive': archive_path.name,
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'entries': len(names),
            'publicExampleConfigOnly': True, 'reproducible': True, 'crcPassed': True,
            'files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}}
(out / 'artifact-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({key: value for key, value in manifest.items() if key != 'files'}))
