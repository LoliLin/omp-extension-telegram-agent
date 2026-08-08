import type {
	CompactionResult,
	InlineExtension,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

type SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };

export function makeTelegramCompactionExtension(
	handle: (event: SessionBeforeCompactEvent) => Promise<SessionBeforeCompactResult>,
): InlineExtension {
	return {
		name: "tg-compaction",
		hidden: true,
		factory: (pi) => {
			pi.on("session_before_compact", handle);
		},
	};
}
