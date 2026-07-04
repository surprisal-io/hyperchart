import type { ActionUID } from "./types.js";

export function actionUidKey(actionUid: ActionUID): string {
	return `${actionUid.chart}:${actionUid.state}:${actionUid.action}`;
}

export function sanitizeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function actionUidDirName(actionUid: ActionUID): string {
	return `${sanitizeSegment(actionUid.chart)}_${sanitizeSegment(actionUid.state)}_${sanitizeSegment(actionUid.action)}`;
}
