"""Recompute all benchmark statistics and export the standalone comparison figure.
Run: uv run --no-project --with matplotlib python <this file>
"""
from pathlib import Path
from statistics import median, mean, quantiles
from hashlib import sha256
from decimal import Decimal, ROUND_HALF_UP
import csv
import json
import math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

folder = Path(__file__).resolve().parent

def load_lines(name):
    return [json.loads(line) for line in (folder / name).read_text().splitlines() if line.strip()]

main = load_lines('main.jsonl')
baseline = load_lines('baseline.jsonl')
pilot = load_lines('pilot.jsonl')
budget = load_lines('budget.jsonl')
judgments = json.loads((folder / 'judge-scores.json').read_text())['evaluations']
review = json.loads((folder / 'author-review.json').read_text())
source_scores = {row['id']: row for row in judgments}
assert len(main) == 48 and all(row['ok'] for row in main)
assert len({(r['caseId'], r['mode'], r['repeat']) for r in main}) == 48
assert len(source_scores) == 48
assert len(baseline) == 8 and len(pilot) == 9
assert all(r['requestedMaxTokens'] == 8192 for r in main)

for override in review['overrides']:
    assert override['id'] in source_scores, f"Unknown anonymous review ID: {override['id']}"

final_scores = {}
for original in judgments:
    row = dict(original)
    override = next((item for item in review['overrides'] if item['id'] == row['id']), None)
    row['rawJudgeScore'] = row['score']
    if override:
        row['criteria'] = override['criteria']
        row['score'] = sum(override['criteria'])
        row['issues'] = override['issues']
        row['authorReviewReason'] = override.get('reason')
    assert 0 <= row['score'] <= 5
    key = (row['caseId'], row['mode'], row['repeat'])
    result = next(r for r in main if (r['caseId'], r['mode'], r['repeat']) == key)
    assert sha256(result['answer'].encode()).hexdigest() == row['answerHash']
    assert result['promptHash'] == row['promptHash']
    final_scores[key] = row
assert len(final_scores) == 48

for case_id in {r['caseId'] for r in main}:
    assert len({r['promptHash'] for r in main if r['caseId'] == case_id}) == 1

categories = ['word', 'translation', 'syntax', 'assistant']
modes = ['none', 'low', 'high']
groups = []
for category in categories:
    for mode in modes:
        rows = [r for r in main if r['category'] == category and r['mode'] == mode]
        assert len(rows) == 4
        durations = [r['totalMs'] / 1000 for r in rows]
        answers = [r['firstAnswerMs'] / 1000 for r in rows]
        reasoning = [r['usage']['completion_tokens_details']['reasoning_tokens'] for r in rows]
        assert all(n == 0 for n in reasoning) if mode == 'none' else all(n > 0 for n in reasoning)
        scores = [final_scores[(r['caseId'], r['mode'], r['repeat'])]['score'] for r in rows]
        group = {
            'category': category, 'mode': mode, 'n': len(rows),
            'medianTotalSeconds': median(durations), 'minTotalSeconds': min(durations), 'maxTotalSeconds': max(durations),
            'totalIQR': [quantiles(durations, n=4, method='inclusive')[i] for i in [0, 2]],
            'medianFirstAnswerSeconds': median(answers),
            'meanQuality': mean(scores), 'qualityScores': scores,
            'medianReasoningTokens': median(reasoning),
            'medianCompletionTokens': median(r['usage']['completion_tokens'] for r in rows),
            'strictJsonSuccess': sum(r['strictJsonValid'] is True for r in rows),
            'structuredResponses': sum(r['strictJsonValid'] is not None for r in rows)
        }
        groups.append(group)

# Independently cross-check the runner's JavaScript timing summary.
runner_summary = json.loads((folder / 'main.jsonl.summary.json').read_text())
for g in groups:
    row = next(r for r in runner_summary if r['key'].endswith(f"|{g['category']}|{g['mode']}"))
    assert math.isclose(row['medianTotalMs'] / 1000, g['medianTotalSeconds'], abs_tol=0.00001)
    assert math.isclose(row['medianFirstAnswerMs'] / 1000, g['medianFirstAnswerSeconds'], abs_tol=0.00001)

by_mode = []
for mode in modes:
    rows = [r for r in main if r['mode'] == mode]
    by_mode.append({
        'mode': mode, 'n': len(rows), 'meanQuality': mean(final_scores[(r['caseId'], mode, r['repeat'])]['score'] for r in rows),
        'medianTotalSeconds': median(r['totalMs'] / 1000 for r in rows),
        'medianFirstAnswerSeconds': median(r['firstAnswerMs'] / 1000 for r in rows),
        'completionTokens': sum(r['usage']['completion_tokens'] for r in rows),
        'reasoningTokens': sum(r['usage']['completion_tokens_details']['reasoning_tokens'] for r in rows),
        'promptTokens': sum(r['usage']['prompt_tokens'] for r in rows)
    })

pairs = []
for case_id, repeat in sorted({(r['caseId'], r['repeat']) for r in main}):
    off = next(r for r in main if (r['caseId'], r['repeat'], r['mode']) == (case_id, repeat, 'none'))
    high = next(r for r in main if (r['caseId'], r['repeat'], r['mode']) == (case_id, repeat, 'high'))
    pairs.append({
        'caseId': case_id, 'repeat': repeat, 'category': off['category'],
        'extraSecondsHigh': (high['totalMs'] - off['totalMs']) / 1000,
        'qualityDeltaHigh': final_scores[(case_id, 'high', repeat)]['score'] - final_scores[(case_id, 'none', repeat)]['score']
    })

stats = {
    'groups': groups, 'byMode': by_mode, 'pairedHighVsOff': pairs,
    'baseline': {'requests': len(baseline), 'successful': sum(r['ok'] for r in baseline), 'withReasoningTokens': sum(r['usage']['completion_tokens_details']['reasoning_tokens'] > 0 for r in baseline), 'reasoningTokensByCase': {r['caseId']: r['usage']['completion_tokens_details']['reasoning_tokens'] for r in baseline}},
    'main': {'requests': len(main), 'successful': sum(r['ok'] for r in main), 'strictJsonSuccessful': sum(r['strictJsonValid'] is True for r in main), 'structuredResponses': sum(r['strictJsonValid'] is not None for r in main), 'firstStartedAt': min(r['startedAt'] for r in main), 'lastStartedAt': max(r['startedAt'] for r in main)},
    'budget': {'requests': len(budget), 'truncatedAttempts': sum(r['truncated'] for r in budget), 'summaries': json.loads((folder / 'budget-summary.json').read_text())},
    'requests': {'main': len(main), 'baseline': len(baseline), 'pilot': len(pilot), 'budget': len(budget), 'qualityJudge': len(load_lines('judge.jsonl'))},
    'qualityInterpretation': 'Five-point diagnostic rubric on eight selected tasks; separate model judge with labels hidden, then author audit. Not a population accuracy estimate or an independent human study.'
}
(folder / 'analysis.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2) + '\n')
(folder / 'final-scores.json').write_text(json.dumps(list(final_scores.values()), ensure_ascii=False, indent=2) + '\n')
with (folder / 'comparison.csv').open('w', newline='') as stream:
    writer = csv.DictWriter(stream, fieldnames=list(groups[0]))
    writer.writeheader()
    writer.writerows(groups)

plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False, 'svg.fonttype': 'none'})
fig, axes = plt.subplots(1, 3, figsize=(16, 5.8))
fig.subplots_adjust(left=0.05, right=0.99, top=0.79, bottom=0.19, wspace=0.25)
colors = ['#22866b', '#5379b8', '#a8589d']
labels = ['Off (none)', 'Low', 'High']
category_labels = ['Word lookup', 'Translation', 'Grammar', 'Assistant']
width = 0.24
for mode_index, mode in enumerate(modes):
    rows = [g for g in groups if g['mode'] == mode]
    xs = [i + (mode_index - 1) * width for i in range(4)]
    for ax, field in zip(axes, ['medianTotalSeconds', 'medianFirstAnswerSeconds', 'meanQuality']):
        bars = ax.bar(xs, [g[field] for g in rows], width=width, label=labels[mode_index], color=colors[mode_index])
        ax.bar_label(bars, labels=[str(Decimal(str(g[field])).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)) for g in rows], padding=3, fontsize=8)
for ax in axes:
    ax.set_xticks(range(4), category_labels, rotation=12)
    ax.grid(axis='y', alpha=0.2)
    ax.set_axisbelow(True)
axes[0].set(title='Median total time', ylabel='Seconds', ylim=(0, 11))
axes[1].set(title='Median time to first answer text', ylabel='Seconds', ylim=(0, 9.5))
axes[2].set(title='Author-audited quality rubric', ylabel='Points (0-5)', ylim=(0, 5.6))
fig.suptitle('DeepSeek-V4.1-Flash via Magpie: thinking mode comparison', fontsize=15, fontweight='bold', y=0.97)
handles, legend_labels = axes[0].get_legend_handles_labels()
fig.legend(handles, legend_labels, loc='upper center', bbox_to_anchor=(0.5, 0.92), ncol=3, frameon=False)
fig.text(0.5, 0.035, '8 tasks x 2 repeats x 3 modes = 48 calls; 4 calls per category/mode. Small, selected sample; results are provider-specific.', ha='center', fontsize=9)
fig.savefig(folder / 'comparison.svg', bbox_inches='tight')
fig.savefig(folder / 'comparison.png', dpi=180, bbox_inches='tight')
plt.close(fig)

for g in groups:
    print(f"{g['category']:12} {g['mode']:4} n={g['n']} total={g['medianTotalSeconds']:.2f}s first={g['medianFirstAnswerSeconds']:.2f}s quality={g['meanQuality']:.3f}/5")
print('By mode:', json.dumps(by_mode, ensure_ascii=False))
print('Requests:', stats['requests'])
print('Main JSON:', stats['main']['strictJsonSuccessful'], '/', stats['main']['structuredResponses'])
print('Baseline with thinking:', stats['baseline']['withReasoningTokens'], '/', len(baseline))
print('Budget truncations:', stats['budget']['truncatedAttempts'])
