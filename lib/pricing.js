const fs = require('node:fs');
const path = require('node:path');

const PRICING_FILE = path.join(__dirname, '..', 'pricing.json');

function loadPricing() {
  return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
}

// "claude-haiku-4-5-20251001" -> "claude-haiku-4-5", "claude-opus-5-5[1m]" -> "claude-opus-5-5"
function normalizeModel(model) {
  return String(model || '')
    .replace(/\[.*?\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/^(us|eu|apac|global)\.anthropic\./, '')
    .replace(/^anthropic\./, '');
}

function rateFor(pricing, model) {
  const id = normalizeModel(model);
  // No fuzzy matching: an unpriced model is reported in the UI rather than guessed.
  return pricing.models[id] || null;
}

// Cost in USD split by token type, or null when the model has no price.
function costParts(pricing, turn) {
  const base = rateFor(pricing, turn.model);
  if (!base) return null;
  let r = base;
  if (base.longContext && turn.context > base.longContext.threshold) r = { ...base, ...base.longContext };
  const f = turn.speed === 'fast' ? pricing.fastMultiplier : 1;
  const mult = pricing.cacheWriteMultiplier;
  return {
    input: (turn.input * r.input * f) / 1e6,
    output: (turn.output * r.output * f) / 1e6,
    cacheWrite: ((turn.cacheWrite5m * mult['5m'] + turn.cacheWrite1h * mult['1h']) * r.input * f) / 1e6,
    cacheRead: (turn.cacheRead * r.cacheRead * f) / 1e6,
  };
}

module.exports = { loadPricing, normalizeModel, costParts };
