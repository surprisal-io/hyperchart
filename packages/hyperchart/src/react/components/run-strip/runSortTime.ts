export function runSortTime(run: { updatedAt?: number; createdAt?: number }): number {
	return run.updatedAt ?? run.createdAt ?? 0;
}
