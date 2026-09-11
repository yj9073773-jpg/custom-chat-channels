import { MODULE_ID, MAIN_CHANNEL_ID, getChannelWhisperTargets, isUserInChannel, normalizeChannel } from "./module-config.js";
import {
  getActiveChannelId,
  setActiveChannel,
  getChannelById,
  getVisibleChannelsForCurrentUser,
  refreshAllTabBars,
  insertTabBar,
  applyChannelVisibility,
  markMessageChannelUnread,
  getLastChannelMessage,
  forgetDetachedMessage,
  applyMessageTextColor
} from "./chat-log-ui.js";

const LOG_PREFIX = "[Chat Channels]";

// ── 초기화 ─────────────────────────────────────────────────────────
Hooks.once("init", () => {
  console.log(`${LOG_PREFIX} Initializing module...`);

  game.settings.register(MODULE_ID, "channels", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  // 현재 보고 있는 탭. 클라이언트별 개인 상태이므로 client scope(기존 극장 모듈의
  // myStandingChannel과 동일한 전례를 따름).
  game.settings.register(MODULE_ID, "activeChannelId", {
    scope: "client",
    config: false,
    type: String,
    default: MAIN_CHANNEL_ID
  });

  // ── [C안, v0.1.2] 채널 미지정 메시지 자동 할당 ────────────────────────
  // 매크로 등 스크립트가 ChatMessage.create()를 직접 호출하는 메시지(예: 채팅 꾸미기용
  // 매크로)는 main.js의 chatMessage 훅을 거치지 않아 whisper/channelId가 전혀 안 붙고,
  // 그 결과 항상 메인(공개) 탭으로 나가버리는 문제가 실사용 중 확인됨.
  // 이 설정을 켜면, whisper도 channelId flag도 없는 "미지정" 신규 메시지를
  // preCreateChatMessage 훅에서 감지해 "메시지를 생성한 클라이언트가 지금 보고 있는
  // 채널 탭"으로 자동으로 whisper+flag를 걸어 좁혀 보낸다 (아래 훅 구현 참고).
  //
  // ⚠️ 주의(사용자 승인 사항): 이건 매크로만 골라내는 것이 아니라 "그 시점에 whisper 없이
  // 생성되는 모든 메시지"에 적용된다. 즉 슬래시 명령(주사위 굴림 등)이나 다른 모듈/시스템이
  // 만드는 공개 안내 메시지도, 생성한 사람이 채널 탭을 보고 있었다면 그 채널로 좁아진다.
  // 이 트레이드오프를 감수하고 기본값을 켜기로 확정됨. 문제가 생기면 이 설정을 끄면 되고,
  // 끄면 미지정 메시지는 예전처럼 항상 공개(메인)로 나간다.
  game.settings.register(MODULE_ID, "autoAssignUntaggedMessages", {
    name: "채널 미지정 메시지 자동 할당",
    hint: "매크로 등 스크립트로 생성되어 채널 태그가 없는 메시지(예: 채팅 꾸미기 매크로)를 지금 보고 있는 채널 탭으로 자동으로 좁혀 보냅니다. 주의: whisper가 없는 모든 신규 메시지(주사위 굴림 등 슬래시 명령 포함)에 적용되므로, 채널 탭을 보고 있는 중에 발생한 공개성 메시지도 그 채널로 좁아질 수 있습니다. 예상치 못하게 메시지가 좁아진다면 이 설정을 꺼주세요.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // ── [Phase 2] 안읽음 채널 표시 ───────────────────────────────────────
  // 채널별로 "안읽음" 여부만 client scope에 저장한다(true/false). 새로고침/재접속 후에도
  // 유지되어야 하므로(스펙 요구), world 설정이 아니라 이 클라이언트 전용 설정에 담아 둔다.
  // 활성 탭을 바꾸면(setActiveChannel) 해당 채널의 안읽음 표시가 지워진다.
  game.settings.register(MODULE_ID, "unreadChannels", {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  // 안읽음 표시(*) 색상. 기본값은 빨간색이며, client scope라 사용자별로 원하는 색으로
  // 바꿀 수 있다(Foundry 모듈 설정 메뉴에서 변경). CSS color로 해석 가능한 값이면 무엇이든 허용
  // (예: #ff0000, red, rgb(...) 등).
  game.settings.register(MODULE_ID, "unreadIndicatorColor", {
    name: "안읽음 표시 색상",
    hint: "새 채널 탭에 안읽은 메시지가 있을 때 표시되는 '*' 기호의 색상입니다. CSS 색상 값(#ff0000, red 등)을 입력하세요.",
    scope: "client",
    config: true,
    type: String,
    default: "#ff0000",
    onChange: () => refreshAllTabBars()
  });

  // 탭 글자색. 빈 문자열이면 기본(상속) 색상을 그대로 사용한다. 탭 배경색은 별도 설정 없이
  // 항상 현재 채팅 카드 배경을 상속한다(스펙 확정 사항).
  game.settings.register(MODULE_ID, "tabFontColor", {
    name: "탭 글자색",
    hint: "채널 탭 글자색입니다. 비워두면 기본 색상을 그대로 사용합니다. CSS 색상 값(#ffffff, white 등)을 입력하세요.",
    scope: "client",
    config: true,
    type: String,
    default: "",
    onChange: () => refreshAllTabBars()
  });

  // [Phase 2 추가] 채팅탭(메인+채널, "+"/"‹""›" 버튼 제외) 배경색. 오퍼시티까지 지정할 수 있도록
  // rgba()나 8자리 hex(#rrggbbaa) 등 알파를 포함한 CSS 색상 문자열을 그대로 허용한다.
  // 비워두면 기존 동작(현재 채팅 카드 배경 상속)을 그대로 유지한다.
  game.settings.register(MODULE_ID, "tabBackgroundColor", {
    name: "탭 배경색",
    hint: "채널 탭(＋, ‹›버튼 제외) 배경색입니다. 오퍼시티를 포함하려면 rgba(255,0,0,0.4) 또는 #ff000066처럼 알파값을 넣어 입력하세요. 비워두면 기본값(채팅 카드 배경 상속)을 사용합니다.",
    scope: "client",
    config: true,
    type: String,
    default: "",
    onChange: () => refreshAllTabBars()
  });

  // [v0.4.1 추가] 일반 채팅 글자색. 탭 글자색/배경색과 동일한 형식(비우면 기본값, CSS 색상
  // 문자열 입력)이지만, 적용 대상이 탭이 아니라 "채팅 메시지 본문 전체"(메인탭+채널탭 공통)라는
  // 점이 다르다. 그래서 탭처럼 렌더될 때마다 컨테이너 하나하나에 style을 심지 않고, 문서
  // 루트(document.documentElement)에 CSS 변수 하나로 설정한다 — 사이드바/팝아웃 등 모든
  // .chat-log가 결국 document 하위이므로 이 값이 자동으로 전부에 상속된다.
  game.settings.register(MODULE_ID, "messageTextColor", {
    name: "일반 채팅 글자색",
    hint: "채팅 메시지 본문(메인탭+채널탭 공통) 글자색입니다. 비워두면 시스템/테마 기본 색상을 그대로 사용합니다. CSS 색상 값(#000000, black 등)을 입력하세요.",
    scope: "client",
    config: true,
    type: String,
    default: "",
    onChange: () => applyMessageTextColor()
  });
  applyMessageTextColor(); // 새로고침 직후에도 저장된 값이 바로 반영되도록 등록 직후 한 번 적용

  // 과거 채팅 로그 초기 렌더는 ready 훅보다 먼저 끝나므로(기존 극장 모듈과 동일한 이유),
  // 반드시 init 단계에서 훅을 등록해야 새로고침 직후에도 필터링이 누락되지 않는다.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      applyChannelVisibility(message, html);
    } catch (err) {
      console.error(`${LOG_PREFIX} 메시지 표시 필터링 중 오류:`, err);
    }
  });

  Hooks.on("renderChatLog", (app, html) => {
    try {
      insertTabBar(app, html);
    } catch (err) {
      console.error(`${LOG_PREFIX} 탭바 삽입 중 오류:`, err);
    }
  });

  // [v0.4.0] 비활성 채널 메시지는 이제 DOM에서 떼어내 캐시에 보관한다(display:none 대신).
  // 메시지 자체가 삭제되면 그 캐시 항목도 같이 정리해줘야 계속 메모리에 안 남는다.
  Hooks.on("deleteChatMessage", (message) => {
    try {
      forgetDetachedMessage(message.id);
    } catch (err) {
      console.error(`${LOG_PREFIX} 삭제된 메시지 캐시 정리 중 오류:`, err);
    }
  });

  // 일반 텍스트 전송을 가로채 활성 채널로 whisper 처리한다.
  // 슬래시 명령(주사위 굴림 등)은 여기서는 가로채지 않고 코어 기본 처리로 그대로 흘려보낸다
  // — 그 결과물(whisper 없는 신규 메시지)은 아래 preCreateChatMessage 훅(C안, 자동 할당
  // 설정이 켜져 있을 때)이 이어받아 현재 채널 탭으로 태깅한다.
  // [Phase 3] "@"로 시작하는 메시지도 동일하게 건너뛴다 — custom-theatre-system의
  // @표정 태그 파싱 훅(chatMessage)이 이 훅보다 나중에 등록되어 있어, 여기서 먼저
  // whisper로 소비해버리면 theatre 쪽이 @태그를 파싱할 기회 자체를 잃는다. 등록된
  // 표정과 일치하면 theatre 쪽이 완전히 소비하고, 일치하지 않는 "@아무말"은 여기 훅을
  // 거치지 않은 채 코어 기본 처리로 흘러가며, 그 결과는 위 preCreateChatMessage의
  // 자동 채널 할당(C안) 안전망이 받아 처리한다(부작용 없음).
  Hooks.on("chatMessage", (_chatLog, messageText) => {
    try {
      if (typeof messageText !== "string" || messageText.startsWith("/") || messageText.startsWith("@")) return;

      const activeId = getActiveChannelId();
      if (!activeId) return; // 메인 탭이면 코어 기본 동작 그대로 둔다.

      const channel = getChannelById(activeId);
      if (!channel) {
        // 보고 있던 채널이 그 사이 삭제된 예외 상황: 메인으로 되돌리고, 이번 메시지는
        // 사용자가 다시 보낼 수 있도록 그대로 소비하지 않는다.
        setActiveChannel(MAIN_CHANNEL_ID);
        return;
      }
      if (!isUserInChannel(channel, game.user)) {
        ui.notifications.warn("이 채널에 참여하고 있지 않습니다.");
        return false;
      }

      const whisper = getChannelWhisperTargets(channel, game.user.id);
      ChatMessage.create({
        content: messageText,
        speaker: ChatMessage.getSpeaker(),
        whisper,
        flags: { [MODULE_ID]: { channelId: channel.id } }
      });
      return false; // 코어의 공개 메시지 생성을 막는다 — 위에서 이미 격리된 메시지를 만들었다.
    } catch (err) {
      console.error(`${LOG_PREFIX} 채널 메시지 전송 처리 중 오류:`, err);
    }
  });

  // world 설정("channels")은 GM이 저장한 그 자리에서 ChannelManagerApp이 직접
  // refreshAllTabBars()를 호출해 갱신한다(버그 1 수정 — updateSetting 훅의 타이밍에
  // 더 이상 의존하지 않음). 이 훅은 "다른 클라이언트(플레이어들)에게 전파"하는 역할만 담당한다.
  Hooks.on("updateSetting", (setting) => {
    if (setting.key !== `${MODULE_ID}.channels`) return;
    try {
      refreshAllTabBars();
      const activeId = getActiveChannelId();
      if (!activeId) return;
      const raw = setting.value ?? {};
      const channel = raw[activeId] ? normalizeChannel(raw[activeId]) : null;
      if (!channel || !isUserInChannel(channel, game.user)) {
        setActiveChannel(MAIN_CHANNEL_ID);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} 채널 설정 갱신 처리 중 오류:`, err);
    }
  });

  // 버그 1 관련: world 설정에 그 키로 최초 저장되는 순간에는 Setting 문서가 새로
  // 생성되며 updateSetting이 아니라 createSetting이 발생한다. 이 최초 생성 시점도
  // 놓치지 않도록 동일한 처리를 붙여준다(주로 다른 클라이언트들을 위한 안전망 —
  // 저장을 실행한 GM 본인 화면은 ChannelManagerApp이 직접 갱신하므로 이 훅과 무관하게 즉시 반영됨).
  Hooks.on("createSetting", (setting) => {
    if (setting.key !== `${MODULE_ID}.channels`) return;
    try {
      refreshAllTabBars();
    } catch (err) {
      console.error(`${LOG_PREFIX} 채널 설정 최초 생성 처리 중 오류:`, err);
    }
  });

  // ── [C안] 채널 미지정 메시지 자동 할당 (설정: autoAssignUntaggedMessages) ──
  // preCreateChatMessage는 메시지를 생성하는 클라이언트에서만 실행되므로, 여기서 읽는
  // activeChannelId(client scope)는 항상 "이 메시지를 만든 사람이 보고 있던 탭"과 정확히
  // 일치한다(다른 접속자의 탭 상태와 섞일 위험 없음).
  Hooks.on("preCreateChatMessage", (message) => {
    try {
      if (!game.settings.get(MODULE_ID, "autoAssignUntaggedMessages")) return;

      // 이미 whisper가 있는 메시지는 절대 건드리지 않는다 — 여기엔 두 경우가 섞여 있다:
      // (1) 우리 chatMessage 훅이 이미 channelId flag까지 붙여서 만든 채널 메시지
      //     (이중 처리 방지), (2) 진짜 개인 귓속말(/w 등) — 이 자동 할당 기능의 대상이
      //     절대 아니므로 반드시 제외해야 한다.
      if (message.whisper?.length) return;
      if (message.getFlag(MODULE_ID, "channelId")) return; // 방어적 이중 확인

      const activeId = getActiveChannelId();
      if (!activeId) return; // 메인 탭을 보고 있었으면 기존 동작대로 공개 메시지 그대로 둔다.

      const channel = getChannelById(activeId);
      if (!channel) return; // 활성 채널 정보가 없으면(삭제 등) 건드리지 않고 공개로 둔다.
      if (!isUserInChannel(channel, game.user)) return; // 방어적: 참여 중이 아니면 건드리지 않는다.

      const whisper = getChannelWhisperTargets(channel, game.user.id);
      message.updateSource({
        whisper,
        [`flags.${MODULE_ID}.channelId`]: channel.id
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} 채널 미지정 메시지 자동 할당 처리 중 오류:`, err);
    }
  });

  // ── [Phase 2] 안읽음 채널 감지 ───────────────────────────────────────
  // createChatMessage는 이 메시지를 최종적으로 받은(=whisper 대상인) 모든 클라이언트에서
  // 각자 실행되므로, 본인이 지금 보고 있지 않은 채널에 새 메시지가 왔을 때만 표시하면 된다.
  // preCreateChatMessage 단계의 자동 채널 할당(위 훅)이 먼저 끝난 뒤의 최종 문서를 보게 되므로
  // channelId flag가 이미 확정된 상태로 들어온다.
  Hooks.on("createChatMessage", (message) => {
    try {
      markMessageChannelUnread(message);
    } catch (err) {
      console.error(`${LOG_PREFIX} 안읽음 채널 표시 처리 중 오류:`, err);
    }
  });

  // ── [Phase 3] 다른 모듈(custom-theatre-system 등)을 위한 이벤트 브로드캐스트 ──
  // whisper 스킵 로직을 직접 건드리지 않고도 채널 메시지를 구독할 수 있도록,
  // 이 메시지를 최종적으로 받은(=whisper 대상인) 각 클라이언트에서 커스텀 훅을 쏜다.
  // 이 훅 자체는 whisper로 이미 격리된 뒤이므로, 참여하지 않은 클라이언트에는
  // 애초에 이 콜백 자체가 실행되지 않는다(메시지 문서를 받지 못하므로) — 별도의
  // 추가 권한 검사 없이도 안전하게 격리가 유지된다.
  // 메인(공개) 탭 메시지는 channelId가 MAIN_CHANNEL_ID("")로 전달된다.
  Hooks.on("createChatMessage", (message) => {
    try {
      const channelId = message.getFlag(MODULE_ID, "channelId") || MAIN_CHANNEL_ID;
      Hooks.callAll("customChatChannelsMessageCreated", message, channelId);
    } catch (err) {
      console.error(`${LOG_PREFIX} 채널 메시지 이벤트 브로드캐스트 중 오류:`, err);
    }
  });
});

Hooks.once("ready", () => {
  // ── [Phase 3] 다른 모듈을 위한 공개 API ──────────────────────────────
  // custom-theatre-system 등 다른 모듈이 이 모듈의 내부 함수를 직접 import하지 않고도
  // (별도 ESM 모듈이라 정적 import가 불가능하므로) 안전하게 접근할 수 있도록 노출한다.
  // Foundry 표준 관례(game.modules.get(id).api)를 따른다.
  game.modules.get(MODULE_ID).api = {
    MAIN_CHANNEL_ID,
    getVisibleChannelsForCurrentUser,
    getChannelById,
    getActiveChannelId,
    setActiveChannel,
    isUserInChannel: (channelId, user = game.user) => {
      const channel = getChannelById(channelId);
      return !!channel && isUserInChannel(channel, user);
    },
    // [버그 1] 스탠딩 채널 등 다른 모듈이 슬롯 전환 시 "마지막 대사 상태"를 즉시
    // 복원하는 데 쓸 수 있도록, 채널별 가장 최근 메시지를 조회하는 API를 노출한다.
    getLastChannelMessage
  };

  console.log(`${LOG_PREFIX} Ready.`);
});
