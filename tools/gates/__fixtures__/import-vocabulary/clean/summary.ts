// Passing fixture for the import-vocabulary gate. Three clean files, so the
// gate's own minimum-files floor is exercised against a directory that really
// does contain that many.

export interface Summary {
  readonly imported: number;
  readonly skipped: number;
  readonly rejected: number;
}
