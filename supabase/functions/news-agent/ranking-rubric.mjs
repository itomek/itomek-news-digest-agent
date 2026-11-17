// Versioned absolute anchors. Editorial policy remains the authority for scope.
export const RANKING_RUBRIC_VERSION='2026-11-16.1';
export function buildRankingInstructions(){
 return `RANKING RUBRIC ${RANKING_RUBRIC_VERSION}. Assign absolute scores, never relative to the current batch or its other candidates. Existing editorial policy decides scope and skip versus verify.
Importance: 0 skip; 1 modest meaningful development; 2 material improvement; 3 important new capability; 4 exceptional major change.
Relevance: 0 skip/outside scope; 1 meaningful but indirect permitted interest; 2 clear stated interest; 3 direct work relevance; 4 strong direct priority.
Each decision must have exactly id, action, reason, importance, relevance. Scores must be integers. skip requires importance=0 and relevance=0. verify requires both scores 1..4. Account for every candidate; do not choose only batch winners.`;
}
