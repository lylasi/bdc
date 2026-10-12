"""Copy the independent chart's public runtime assets, never its private config.
Usage: python3 scripts/update-phonetic-assets.py /path/to/phonetic-chart
"""
import argparse
from pathlib import Path
import shutil

RUNTIME = ('index.html', 'styles.css', 'words.css', 'data.js', 'word-audio.js',
           'audio.js', 'articulation.js', 'mobile-details.js', 'ui.js', 'help.js',
           'word-split.js', 'word-entry.js', 'SOURCES.md')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    target = Path(__file__).resolve().parents[1] / 'phonetic-chart'
    source = args.source.resolve()
    if source == target.resolve():
        parser.error('Source and destination must differ')
    for name in RUNTIME:
        if not (source / name).is_file():
            parser.error('Missing runtime asset: ' + name)
    target.mkdir(exist_ok=True)
    for name in RUNTIME:
        shutil.copy2(source / name, target / name)
    for name in ('audio', 'assets'):
        shutil.copytree(source / name, target / name, dirs_exist_ok=True)
    index = target / 'index.html'
    index.write_text(index.read_text().replace('href="words.html"', 'href="../phonetics.html"'))
    print('Updated static phonetic assets in', target)

if __name__ == '__main__':
    main()
