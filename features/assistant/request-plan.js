// Snapshot-aware planning for one assistant turn.
//
// The first send resolves "follow settings" into a concrete thinking level and
// freezes the model spec. A retry must reuse both snapshots; otherwise a change
// to the task thinking setting or the selected model would silently change what
// the retry means.
import { normalizeThinkingLevel } from '../../modules/ai-thinking.js';
import { stringifyModelSpec } from '../../modules/ai-models.js';

export function resolveAssistantRequestPlan({
    snapshot = null,
    selectedThinking = 'auto',
    currentModelSpec = '',
    resolveTaskThinking = () => 'auto'
} = {}) {
    const fromSnapshot = !!snapshot;
    const chosen = normalizeThinkingLevel(fromSnapshot ? snapshot.thinking : selectedThinking, 'auto');
    const thinking = (!fromSnapshot && chosen === 'auto')
        ? normalizeThinkingLevel(resolveTaskThinking(), 'auto')
        : chosen;
    const snapshotModel = fromSnapshot ? stringifyModelSpec(snapshot.model) : '';
    const model = snapshotModel || stringifyModelSpec(currentModelSpec);
    return { thinking, model };
}
