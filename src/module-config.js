export const MODULE_ID = "custom-chat-channels";
export const SOCKET_NAME = `module.${MODULE_ID}`;

// 메인(기본) 채팅 탭을 가리키는 값. 실제 채널이 아니라 "채널 미지정" 상태를 의미하며,
// 코어 채팅 로그의 원래 동작(모두에게 보이는 일반 채팅)을 그대로 사용한다.
// game.settings의 type: String과 궁합이 맞도록 null 대신 빈 문자열을 사용한다.
export const MAIN_CHANNEL_ID = "";

/**
 * 채널 하나의 데이터 형태를 정규화한다.
 * participantIds에는 플레이어만 담고, GM은 절대 담지 않는다(4-A. GM 예외 확정 사항).
 * GM 목록은 항상 실시간으로 game.users에서 다시 계산해서 whisper에 합쳐 넣는다
 * (특정 시점에 GM이었던 유저 id를 박제해두면, 이후 GM 권한이 바뀌었을 때 어긋나기 때문).
 */
export function normalizeChannel(raw = {}) {
  const id = typeof raw.id === "string" && raw.id ? raw.id : foundry.utils.randomID();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "새 채널";
  const participantIds = Array.isArray(raw.participantIds)
    ? [...new Set(raw.participantIds.filter((id) => typeof id === "string" && id))]
    : [];
  return { id, name, participantIds };
}

/** 현재 GM 권한을 가진 모든 유저(온/오프라인 무관)의 id 목록. */
export function getAllGmUserIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
}

/**
 * 채널로 보낼 메시지의 whisper 대상 목록을 계산한다.
 * 참여자 + GM 전원(항상 자동 포함, 4-A) + 작성자 본인(코어가 자동 처리하지만 명시적으로 포함해 방어적으로 둔다).
 */
export function getChannelWhisperTargets(channel, authorUserId) {
  return [...new Set([...channel.participantIds, ...getAllGmUserIds(), authorUserId])];
}

/** 현재 유저(플레이어)가 특정 채널에 실제로 참여 중인지 (GM은 모든 채널에 항상 참여한 것으로 취급). */
export function isUserInChannel(channel, user) {
  if (user.isGM) return true;
  return channel.participantIds.includes(user.id);
}
