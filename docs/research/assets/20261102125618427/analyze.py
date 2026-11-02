"""Compute the multi-route study from immutable answers and anonymous scores.
Run with uv run --no-project --with matplotlib python <this file>.
"""
from pathlib import Path
from statistics import mean, median
from hashlib import sha256
from decimal import Decimal, ROUND_HALF_UP
import csv
import json
import math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
import numpy as np

folder = Path(__file__).resolve().parent

def load_lines(name):
    path = folder / name
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []

def maybe_json(name, default):
    path = folder / name
    return json.loads(path.read_text()) if path.exists() else default

def med(values):
    valid = [value for value in values if value is not None and math.isfinite(value)]
    return median(valid) if valid else None

def fmt(value, places=2):
    return str(Decimal(str(value)).quantize(Decimal('0.' + '0' * places), rounding=ROUND_HALF_UP)) if value is not None else '—'

def key(row):
    return row['targetId'], row['caseId'], row['mode'], row['repeat']

manifest = json.loads((folder / 'main.jsonl.manifest.json').read_text())
state = json.loads((folder / 'main.jsonl.status.json').read_text())
rows = load_lines('main.jsonl')
targets = manifest['targets']
cases = {item['id']: item for item in manifest['cases']}
assert len(rows) == state['requests']
assert len({key(r) for r in rows}) == len(rows)
for r in rows:
    assert r['promptHash'] == cases[r['caseId']]['promptHash']
    assert r['requestedMaxTokens'] == 8192
    assert r['requestParameters']['reasoning_effort'] == r['mode']
    assert not any(k.lower() in ['authorization', 'headers', 'apikey', 'key'] for k in r)

primary = maybe_json('primary-scores.json', {'evaluations': []})['evaluations']
secondary = maybe_json('secondary-scores.json', {'evaluations': []})['evaluations']
review = maybe_json('author-review.json', {'reviewComplete': False, 'overrides': []})
by_id = {r['id']: r for r in primary}
assert len(by_id) == len(primary)
for item in review['overrides']:
    assert item['id'] in by_id, item['id']
scores = {}
for item in primary:
    row = dict(item)
    found = next((o for o in review['overrides'] if o['id'] == row['id']), None)
    row['rawPrimaryScore'] = row['score']
    if found:
        row['criteria'] = found['criteria']
        row['score'] = sum(found['criteria'])
        row['issues'] = found['issues']
        row['authorReason'] = found.get('reason')
    rubric = cases[row['caseId']]['rubric']
    maxima = [float(rule.split(':', 1)[0]) for rule in rubric]
    assert len(row['criteria']) == len(maxima)
    assert math.isclose(sum(maxima), 5)
    assert all(0 <= value <= maximum and math.isclose(value * 2, round(value * 2)) for value, maximum in zip(row['criteria'], maxima))
    assert math.isclose(sum(row['criteria']), row['score'])
    assert 0 <= row['score'] <= 5
    original = next(r for r in rows if key(r) == key(row))
    assert row['answerHash'] == sha256(original['answer'].encode()).hexdigest()
    assert row['promptHash'] == original['promptHash']
    assert row['bodyHash'] == original['bodyHash']
    scores[key(row)] = row
assert not primary or len(scores) == len(rows)

# Token evidence is normalized only for analysis. Missing evidence stays null.
evidence_rows = list(rows)
for name in ['screen-hapi.jsonl', 'screen-hard.jsonl', 'nonstream-parity.jsonl']:
    evidence_rows.extend(load_lines(name))
legacy_map = {t['model']: t for t in targets}
for old in load_lines('magpie-screen.jsonl'):
    target = legacy_map[old['model']]
    usage = old.get('usage') or {}
    rt = (usage.get('completion_tokens_details') or {}).get('reasoning_tokens')
    evidence_rows.append({**old, 'targetId': target['id'], 'channel': 'Magpie', 'reasoningTokens': rt})

evidence = []
route_checks = {item['targetId']: item for item in maybe_json('effective-route-checks.json', [])}
for target in targets + [{'id': 'hapi-grokchat', 'label': 'HAPI Grok Chat Fast'}]:
    all_r = [r for r in evidence_rows if r.get('targetId') == target['id'] and r.get('httpStatus') == 200]
    off = [r for r in all_r if r['mode'] == 'none']
    high = [r for r in all_r if r['mode'] == 'high']
    positive_off = [r for r in off if (r.get('reasoningTokens') or 0) > 0 or r.get('reasoningChars', 0) > 0]
    conflicts = [r for r in all_r if r.get('reasoningTokens') == 0 and r.get('reasoningChars', 0) > 0]
    zero_off = [r for r in off if r.get('reasoningTokens') == 0 and r.get('reasoningChars', 0) == 0]
    positive_high = [r for r in high if (r.get('reasoningTokens') or 0) > 0 or r.get('reasoningChars', 0) > 0]
    if positive_off:
        classification = 'none_still_reasoning'
    elif conflicts:
        classification = 'counter_inconsistent_off_unverified'
    elif off and len(zero_off) == len(off) and positive_high:
        classification = 'off_observed_zero_high_positive'
    else:
        classification = 'insufficient_evidence'
    effective = route_checks.get(target['id'], {}).get('route', {})
    if effective.get('effort') and effective['effort'] != 'none':
        classification = 'mapped_low_still_reasoning' if positive_off else 'mapped_low_no_reasoning_observed'
    evidence.append({'targetId': target['id'], 'label': target['label'], 'classification': classification,
        'effectiveRequestedNone': effective.get('effort'), 'servedRouteForNone': effective.get('served'),
        'noneSamples': len(off), 'nonePositiveThought': len(positive_off), 'noneReportedZeroNoText': len(zero_off),
        'highPositiveThought': len(positive_high), 'zeroCounterWithThoughtText': len(conflicts),
        'missingReasoningCounter': sum(r.get('reasoningTokens') is None for r in all_r)})

def group_summary(subset):
    good = [r for r in subset if r['ok']]
    graded = [scores[key(r)]['score'] for r in subset if key(r) in scores]
    graded_good = [scores[key(r)]['score'] for r in good if key(r) in scores]
    return {'n': len(subset), 'successful': len(good), 'successRate': len(good) / len(subset) if subset else None,
        'medianTotalSeconds': med([r['totalMs'] / 1000 for r in good]),
        'medianFirstAnswerSeconds': med([r['firstAnswerMs'] / 1000 if r['firstAnswerMs'] is not None else None for r in good]),
        'minTotalSeconds': min((r['totalMs'] / 1000 for r in good), default=None),
        'maxTotalSeconds': max((r['totalMs'] / 1000 for r in good), default=None),
        'meanQualityAll': mean(graded) if graded else None,
        'meanQualitySuccessful': mean(graded_good) if graded_good else None,
        'strictJsonValid': sum(r['strictJsonValid'] is True for r in subset),
        'structuredResponses': sum(r['strictJsonValid'] is not None for r in subset),
        'medianReasoningTokens': med([r.get('reasoningTokens') for r in good]),
        'thoughtTextResponses': sum(r.get('reasoningChars', 0) > 0 for r in subset),
        'errors': [{'caseId': r['caseId'], 'repeat': r['repeat'], 'error': r['error']} for r in subset if not r['ok']]}

categories = ['word', 'translation', 'syntax', 'assistant']
modes = ['none', 'high']
overall = []
groups = []
for target in targets:
    for mode in modes:
        selected = [r for r in rows if r['targetId'] == target['id'] and r['mode'] == mode]
        overall.append({'targetId': target['id'], 'label': target['label'], 'channel': target['channel'], 'model': target['model'], 'mode': mode, **group_summary(selected)})
        for category in categories:
            subset = [r for r in selected if r['category'] == category]
            groups.append({'targetId': target['id'], 'label': target['label'], 'mode': mode, 'category': category, **group_summary(subset)})

pairs = []
for target in targets:
    off = [r for r in rows if r['targetId'] == target['id'] and r['mode'] == 'none']
    for r in off:
        high = next((h for h in rows if h['targetId'] == r['targetId'] and h['caseId'] == r['caseId'] and h['repeat'] == r['repeat'] and h['mode'] == 'high'), None)
        if not high:
            continue
        pairs.append({'targetId': r['targetId'], 'caseId': r['caseId'], 'repeat': r['repeat'], 'bothSuccessful': r['ok'] and high['ok'],
            'extraHighSeconds': (high['totalMs'] - r['totalMs']) / 1000 if r['ok'] and high['ok'] else None,
            'qualityDeltaHigh': scores[key(high)]['score'] - scores[key(r)]['score'] if key(high) in scores and key(r) in scores else None})

disagreements = []
for audit in secondary:
    if not primary:
        continue
    assert audit['id'] in by_id, 'Secondary review does not match the primary answer map'
    primary_row = by_id[audit['id']]
    diff = audit['score'] - primary_row['score']
    disagreements.append({'id': audit['id'], 'caseId': audit['caseId'], 'primary': primary_row['score'], 'secondary': audit['score'], 'difference': diff,
        'primaryIssues': primary_row['issues'], 'secondaryIssues': audit['issues']})

flagged_ids = {r['id'] for r in primary if r['score'] < 5 or not r['ok']}
flagged_ids.update(r['id'] for r in disagreements if abs(r['difference']) >= 1)
audit_queue = []
for item in primary:
    if item['id'] not in flagged_ids:
        continue
    original = next(r for r in rows if key(r) == key(item))
    audit_queue.append({'id': item['id'], 'caseId': item['caseId'], 'score': item['score'], 'criteria': item['criteria'], 'issues': item['issues'],
        'secondary': next((r for r in disagreements if r['id'] == item['id']), None), 'answer': original['answer'], 'generationError': original['error']})

parity = load_lines('nonstream-parity.jsonl')
parity_summary = []
for target in [t for t in targets if t['id'] in ['hapi-grok420', 'hapi-grok43', 'magpie-deepseek', 'magpie-gpt']]:
    for mode in ['default', 'none', 'high']:
        subset = [r for r in parity if r['targetId'] == target['id'] and r['mode'] == mode]
        if not subset:
            continue
        parity_summary.append({'targetId': target['id'], 'mode': mode, 'n': len(subset), 'successful': sum(r['ok'] for r in subset),
            'responseTypes': sorted({r.get('responseType') or 'unknown' for r in subset}),
            'errors': [{'caseId': r['caseId'], 'error': r['error']} for r in subset if not r['ok']]})

summary = {'mainRequests': len(rows), 'mainSuccessful': sum(r['ok'] for r in rows), 'plannedRequests': 256, 'quarantined': state.get('quarantined', []),
    'qualityReviewComplete': review.get('reviewComplete', False), 'graded': len(primary), 'secondarySample': len(secondary),
    'secondaryMeanAbsoluteDifference': mean(abs(r['difference']) for r in disagreements) if disagreements else None,
    'overall': overall, 'byTask': groups, 'evidence': evidence, 'pairs': pairs, 'parity': parity_summary,
    'disagreements': disagreements, 'health': maybe_json('health-summary.json', {}), 'healthFinal': maybe_json('health-final-summary.json', {}), 'effectiveRoutes': list(route_checks.values()),
    'requestCounts': {name: len(load_lines(name)) for name in ['magpie-screen.jsonl', 'screen-hapi.jsonl', 'screen-hard.jsonl', 'main.jsonl', 'nonstream-parity.jsonl', 'primary-judge.jsonl', 'secondary-judge.jsonl', 'health.jsonl', 'health-final.jsonl'] + [path.name for path in sorted(folder.glob('mapping-*.jsonl'))]},
    'method': 'Requested none/high. Zero counters alone do not establish disabled reasoning. Medians exclude failed generation; quality and response usability are reported separately. No human panel or statistical significance claim.'}
(folder / 'analysis.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
(folder / 'final-scores.json').write_text(json.dumps(list(scores.values()), ensure_ascii=False, indent=2) + '\n')
(folder / 'audit-queue.json').write_text(json.dumps(audit_queue, ensure_ascii=False, indent=2) + '\n')
with (folder / 'comparison.csv').open('w', newline='') as stream:
    fields = ['targetId', 'label', 'mode', 'category', 'n', 'successful', 'successRate', 'medianTotalSeconds', 'medianFirstAnswerSeconds', 'meanQualityAll', 'meanQualitySuccessful', 'medianReasoningTokens']
    writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore')
    writer.writeheader(); writer.writerows(groups)

plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 9, 'axes.spines.top': False, 'axes.spines.right': False, 'svg.fonttype': 'none'})
labels = [t['label'] + (' · Magpie' if t['channel'] == 'Magpie' else '') for t in targets]
colors = ['#25866c', '#ad5999']
fig, axes = plt.subplots(2, 2, figsize=(16, 12))
fig.subplots_adjust(left=0.19, right=0.97, top=0.86, bottom=0.09, wspace=0.55, hspace=0.27)
for ax, category, title in zip(axes.flat, categories, ['Word / phrase lookup', 'Paragraph translation', 'Syntax analysis', 'Assistant questions']):
    for mode_index, mode in enumerate(modes):
        values = [next(g for g in groups if g['targetId'] == t['id'] and g['category'] == category and g['mode'] == mode) for t in targets]
        ys = np.arange(len(targets)) + (mode_index - 0.5) * 0.34
        bars = ax.barh(ys, [g['medianTotalSeconds'] or 0 for g in values], height=0.33, color=colors[mode_index], label=f"'{mode}' request")
        for bar, g in zip(bars, values):
            degraded = g['successRate'] is not None and g['successRate'] < 0.9
            if degraded:
                bar.set_facecolor('#b7bdc4')
                bar.set_hatch('///')
            annotation = fmt(g['medianTotalSeconds']) + (f" ({g['successful']}/{g['n']})" if degraded else '')
            ax.text(bar.get_width() + 0.05, bar.get_y() + bar.get_height() / 2, annotation, va='center', fontsize=8)
    ax.set_yticks(np.arange(len(targets)), labels)
    ax.invert_yaxis()
    ax.set_title(title, fontweight='bold')
    ax.set_xlabel('Median total seconds (successful calls)')
    ax.grid(axis='x', alpha=0.18); ax.set_axisbelow(True)
    ax.margins(x=0.16)
fig.suptitle('Multi-route BDC task timing — requested none vs high', fontsize=16, fontweight='bold', y=0.97)
handles = [Patch(facecolor=colors[0], label="'none' request"), Patch(facecolor=colors[1], label="'high' request"), Patch(facecolor='#b7bdc4', hatch='///', label='Degraded response rate; valid n shown')]
fig.legend(handles=handles, loc='upper center', bbox_to_anchor=(0.6, 0.94), ncol=3, frameon=False)
fig.text(0.5, 0.025, 'Requested none is not guaranteed to disable reasoning. Hatched bars exclude failed replies from timing and must not be ranked by speed alone.', ha='center', fontsize=9)
fig.savefig(folder / 'latency-by-task.png', dpi=160, bbox_inches='tight')
fig.savefig(folder / 'latency-by-task.svg', bbox_inches='tight')
plt.close(fig)

if primary:
    quality_matrix = np.array([[next(g for g in groups if g['targetId'] == t['id'] and g['mode'] == mode and g['category'] == cat)['meanQualityAll'] for cat in categories] for t in targets for mode in modes], dtype=float)
    success_matrix = np.array([[next(g for g in groups if g['targetId'] == t['id'] and g['mode'] == mode and g['category'] == cat)['successRate'] for cat in categories] for t in targets for mode in modes], dtype=float)
    row_labels = [t['label'] + f" · {mode}" for t in targets for mode in modes]
    fig, axes = plt.subplots(1, 2, figsize=(15, 11), gridspec_kw={'width_ratios': [1, 1]})
    fig.subplots_adjust(left=0.24, right=0.95, top=0.88, bottom=0.12, wspace=0.4)
    plots = [axes[0].imshow(quality_matrix, vmin=0, vmax=5, cmap='YlGnBu', aspect='auto'), axes[1].imshow(success_matrix, vmin=0, vmax=1, cmap='YlGnBu', aspect='auto')]
    for axis_index, ax in enumerate(axes):
        ax.set_xticks(range(4), ['Word', 'Translation', 'Syntax', 'Assistant'], rotation=12)
        ax.set_yticks(range(len(row_labels)), row_labels if axis_index == 0 else [])
        for i, (target, mode) in enumerate((t, m) for t in targets for m in modes):
            for j, category in enumerate(categories):
                g = next(g for g in groups if g['targetId'] == target['id'] and g['mode'] == mode and g['category'] == category)
                value = quality_matrix[i, j] if axis_index == 0 else success_matrix[i, j]
                text = fmt(g['meanQualityAll']) if axis_index == 0 else f"{g['successful']}/{g['n']}"
                ax.text(j, i, text, ha='center', va='center', color='white' if value > (3 if axis_index == 0 else 0.6) else 'black', fontsize=9)
        fig.colorbar(plots[axis_index], ax=ax, fraction=0.04, pad=0.03)
    axes[0].set_title('Anonymous content rubric (0–5, all answers)', fontweight='bold')
    axes[1].set_title('Usable response count / attempted', fontweight='bold')
    fig.suptitle('Quality and response usability are separate outcomes', fontsize=16, fontweight='bold', y=0.97)
    fig.text(0.5, 0.025, 'Synthetic 12-task study; model rubric grading with a second-model audit sample. Small differences are not population accuracy estimates.', ha='center', fontsize=9)
    fig.savefig(folder / 'quality-and-reliability.png', dpi=160, bbox_inches='tight')
    fig.savefig(folder / 'quality-and-reliability.svg', bbox_inches='tight')
    plt.close(fig)

print(json.dumps({'mainRequests': len(rows), 'mainSuccessful': summary['mainSuccessful'], 'graded': len(primary), 'secondarySample': len(secondary), 'auditQueue': len(audit_queue), 'reviewComplete': summary['qualityReviewComplete']}, ensure_ascii=False))
for target in targets:
    off = next(r for r in overall if r['targetId'] == target['id'] and r['mode'] == 'none')
    high = next(r for r in overall if r['targetId'] == target['id'] and r['mode'] == 'high')
    e = next(r for r in evidence if r['targetId'] == target['id'])
    print(target['id'], 'none/high seconds', fmt(off['medianTotalSeconds']), fmt(high['medianTotalSeconds']), 'quality', fmt(off['meanQualityAll']), fmt(high['meanQualityAll']), 'usable', f"{off['successful']}/{off['n']}", f"{high['successful']}/{high['n']}", e['classification'])
