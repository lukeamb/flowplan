export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const SYNC_FRAME_OVERHEAD_BYTES = 12;

export function syncFrameBytes(updateBytes: number): number {
	return updateBytes + SYNC_FRAME_OVERHEAD_BYTES;
}
