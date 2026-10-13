import type { ProjectProfile, QualityAnalyzer } from '@amp/core';

/**
 * Registers stack-specific QualityAnalyzers.
 * Pipeline steps resolve via profile — no giant switch on Node/DotNet/Java.
 */
export class QualityAnalyzerRegistry {
  private readonly analyzers: QualityAnalyzer[] = [];

  register(analyzer: QualityAnalyzer): void {
    const exists = this.analyzers.some((a) => a.name === analyzer.name);
    if (exists) {
      return;
    }
    this.analyzers.push(analyzer);
  }

  resolve(profile: ProjectProfile): QualityAnalyzer | null {
    for (const analyzer of this.analyzers) {
      if (analyzer.supports(profile)) {
        return analyzer;
      }
    }
    return null;
  }

  list(): readonly QualityAnalyzer[] {
    return this.analyzers;
  }
}
