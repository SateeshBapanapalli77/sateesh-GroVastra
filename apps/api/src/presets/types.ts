export interface PresetEvaluator {
  key: string;
  validateConfig(config: any): { valid: boolean; errors: any[]; warnings: any[] };
  planFromFacts?(context: any): Promise<any>;
  checkStopAtDispatch?(context: any): Promise<{ stop: boolean; reason?: string }>;
}

const evaluators = new Map<string, PresetEvaluator>();

export function registerPresetEvaluator(evaluator: PresetEvaluator): void {
  evaluators.set(evaluator.key.toLowerCase(), evaluator);
  evaluators.set(evaluator.key.toUpperCase(), evaluator);
}

export function getPresetEvaluator(key: string): PresetEvaluator | undefined {
  return evaluators.get(key.toLowerCase()) || evaluators.get(key.toUpperCase());
}

// Register default evaluators for existing presets
registerPresetEvaluator({
  key: 'birthday',
  validateConfig: () => ({ valid: true, errors: [], warnings: [] }),
});

registerPresetEvaluator({
  key: 'anniversary',
  validateConfig: () => ({ valid: true, errors: [], warnings: [] }),
});

registerPresetEvaluator({
  key: 'win_back',
  validateConfig: () => ({ valid: true, errors: [], warnings: [] }),
});
