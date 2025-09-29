// Simple cross-module signal for data changes to trigger auto-sync
// Consumers can listen: window.addEventListener('bdc:data-changed', (e) => { ... })

export function touch(group) {
  try {
    const detail = { group: group || 'unknown', at: Date.now() };
    window.dispatchEvent(new CustomEvent('bdc:data-changed', { detail }));
  } catch (_) {
    // ignore
  }
}

