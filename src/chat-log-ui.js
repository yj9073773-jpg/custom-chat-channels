import { ChannelManagerApp } from "./ChannelManagerApp.js";
import { MODULE_ID, MAIN_CHANNEL_ID, normalizeChannel, isUserInChannel } from "./module-config.js";

// 렌더된 탭바 DOM 컨테이너들(메인 사이드바 + 팝아웃 채팅창 등 여러 개 있을 수 있음).
// 채널 목록/활성 탭이 바뀔 때마다 이 목록을 순회하며 다시 그린다.
let tabBarContainers = [];

/**
 * ── [v0.4.0] display:none 방식 → 실제 DOM 분리(detach) 방식으로 전환 ──────────
 *
 * 배경: chatlog-prune(필수 병행 모듈)은 과거 배치를 불러온 뒤 그중 "style.display
 * !== 'none'"인 것의 개수가 목표 배치 크기(기본 25)에 못 미치면 "아직 화면에 보이는
 * 게 부족하다"고 판단해 최대 250개까지 계속 더 과거로 파고든다. 우리가 비활성 채널
 * 메시지를 display:none으로 숨기던 예전 방식은, chatlog-prune 입장에서 "방금 불러온
 * 배치 대부분이 안 보인다"로 읽혀서 이 안전장치를 오작동시켜 스크롤을 살짝만 올려도
 * 히스토리 전체가 한 번에 로딩되는 원인이었다.
 *
 * 해결: 비활성 채널 메시지는 style만 숨기지 않고 DOM에서 아예 떼어내(remove) 이
 * detachedMessages 캐시에 보관한다. chatlog-prune이 배치를 렌더링한 직후 읽는
 * style.display는 우리가 건드리지 않으므로 항상 기본값(=보임)으로 읽히고, 실제
 * 분리는 별도의 MutationObserver(watchChatLogInsertions)가 그 직후 마이크로태스크
 * 시점에 처리한다 — chatlog-prune의 개수 판정 시점(동기 코드)보다 항상 뒤에 실행되므로
 * 판정 자체에는 영향을 주지 않는다.
 *
 * 부수 효과(의도된 이득): chatlog-prune의 프루닝 임계값(children.length 기준)도 이제
 * "현재 활성 채널에 실제로 쌓인 메시지 수"만 반영하게 되어, 다른 채널의 대화량과
 * 무관하게 원래 의도대로 동작한다.
 */
// 사이드바 채팅창과 팝아웃 채팅창은 같은 메시지라도 각자 독립적으로(별개의 DOM 노드로)
// 렌더링한다(chatlog-prune README: "maintains its own tracking ... per chat window
// instance"). 그래서 캐시도 컨테이너(.chat-log)별로 분리해야 한다 — 안 그러면 사이드바에서
// 뗀 노드를 팝아웃에 붙이는(혹은 그 반대) 실수가 생긴다.
const detachedByContainer = new WeakMap(); // container(.chat-log) -> Map(messageId -> { element, channelId })
const observedChatLogs = new WeakSet(); // 이미 MutationObserver를 붙인 .chat-log 엘리먼트

/**
 * [v0.4.1] container(.chat-log) -> 그 채팅 로그를 렌더링한 ChatLog 앱 인스턴스(팝아웃 포함).
 * chatlog-prune이 공개하는 renderBatch()는 정적 함수가 아니라 인스턴스 메서드라서,
 * "이 탭 화면이 비어있으니 더 로딩시켜달라"고 요청하려면 해당 인스턴스 참조가 필요하다.
 * renderChatLog 훅에서 넘겨주는 app을 insertTabBar()가 여기 저장해둔다.
 */
const chatAppByLogElement = new WeakMap();

// [v0.4.1] ensureChannelMessagesLoaded가 한 채널당 renderBatch()를 반복 호출하는 상한.
// chatlog-prune 자신도 "목표치 달성"을 위해 최대 batchSize*10(기본 250)까지 파고드는 걸
// 감안해, 우리도 무한정 반복하지 않도록 별도 상한을 둔다(대상 채널에 메시지가 아주
// 드물게 섞여 있어 여러 배치를 거쳐야 나타나는 경우를 커버하되, 존재하지 않는 메시지를
// 찾아 영원히 반복하는 사고는 막는다).
const ENSURE_LOAD_MAX_ATTEMPTS = 8;

function getContainerCache(container) {
  let cache = detachedByContainer.get(container);
  if (!cache) {
    cache = new Map();
    detachedByContainer.set(container, cache);
  }
  return cache;
}

/**
 * [버그 C 수정] 탭별 스크롤 위치 기억.
 * container(.chat-log) -> Map(channelId -> scrollTop). detachedByContainer와 마찬가지로
 * 사이드바/팝아웃이 각자 독립된 스크롤을 가지므로 컨테이너별로 분리해서 기억한다.
 */
const scrollStateByContainer = new WeakMap();

/** 채널을 떠나기 직전(activeChannelId가 바뀌기 전)에 지금 스크롤 위치를 기억해둔다. */
function captureScrollPositions(channelId) {
  document.querySelectorAll(".chat-log").forEach((container) => {
    let map = scrollStateByContainer.get(container);
    if (!map) {
      map = new Map();
      scrollStateByContainer.set(container, map);
    }
    map.set(channelId, container.scrollTop);
  });
}

/**
 * 새로 활성화된 채널의 스크롤 위치를 복원한다. 이 컨테이너에서 그 채널을 본 적이 있으면
 * 기억해둔 위치 그대로, 처음 보는 채널(또는 새로고침 직후처럼 기억이 없는 경우)이면
 * 기존 동작대로 맨 아래로 이동시킨다 — 이때는 이미지 로딩까지 기다리는 core의
 * scrollBottom()을 그대로 활용해 높이 계산 오차를 피한다.
 */
function restoreScrollPositions(channelId) {
  let anyMissing = false;
  document.querySelectorAll(".chat-log").forEach((container) => {
    const map = scrollStateByContainer.get(container);
    const saved = map?.get(channelId);
    if (saved !== undefined) container.scrollTop = saved;
    else anyMissing = true;
  });
  if (anyMissing) ui.chat?.scrollBottom({ popout: true, waitImages: true });
}

// ── 데이터 조회 헬퍼 ───────────────────────────────────────────────
export function getAllChannels() {
  const raw = game.settings.get(MODULE_ID, "channels") ?? {};
  return Object.values(raw).map((c) => normalizeChannel(c));
}

export function getChannelById(channelId) {
  if (!channelId) return null;
  const raw = game.settings.get(MODULE_ID, "channels") ?? {};
  return raw[channelId] ? normalizeChannel(raw[channelId]) : null;
}

/** 현재 유저가 볼 수 있는(탭에 노출할) 채널 목록. GM은 전체, 플레이어는 참여 중인 채널만. */
export function getVisibleChannelsForCurrentUser() {
  const all = getAllChannels();
  if (game.user.isGM) return all;
  return all.filter((c) => isUserInChannel(c, game.user));
}

export function getActiveChannelId() {
  return game.settings.get(MODULE_ID, "activeChannelId") || MAIN_CHANNEL_ID;
}

/**
 * [일반 채팅 글자색] messageTextColor 설정값을 문서 루트에 CSS 변수(--ccc-message-text-color)로
 * 반영한다. 탭 글자색/배경색(tabFontColor/tabBackgroundColor)과 달리 이 값은 탭이 아니라
 * "채팅 메시지 본문 전체"(메인탭+채널탭 공통)에 적용돼야 하므로, renderTabBarContent처럼
 * 컨테이너 하나하나에 다시 그릴 때마다 style을 심는 방식 대신, 문서 루트 한 곳에만 설정한다
 * — 사이드바/팝아웃 등 모든 .chat-log가 결국 document 하위라 이 값이 자동으로 상속된다.
 * CSS 쪽(chat-channels.css)에서 `var(--ccc-message-text-color, unset) !important`로 읽는다:
 * 값이 없을 때는 "unset"으로 폴백해 원래(시스템/테마 기본) 색상이 그대로 보이게 한다.
 */
export function applyMessageTextColor() {
  const color = game.settings.get(MODULE_ID, "messageTextColor") || "";
  if (color) document.documentElement.style.setProperty("--ccc-message-text-color", color);
  else document.documentElement.style.removeProperty("--ccc-message-text-color");
}

export async function setActiveChannel(channelId) {
  const normalized = channelId || MAIN_CHANNEL_ID;
  const previousId = getActiveChannelId();
  if (previousId === normalized) return;

  // [버그 C] 떠나는 탭의 스크롤 위치를 채널 전환 전에 미리 기억해둔다(전환 후에는
  // 메시지가 재부착되며 scrollHeight가 이미 새 채널 기준으로 바뀌어 있으므로 늦다).
  captureScrollPositions(previousId);

  await game.settings.set(MODULE_ID, "activeChannelId", normalized);
  // [Phase 2] 탭을 열어봤으니 그 채널의 안읽음 표시를 지운다(메인 탭엔 안읽음 개념이 없음).
  if (normalized !== MAIN_CHANNEL_ID && getUnreadMap()[normalized]) {
    await setChannelUnread(normalized, false);
  }
  refreshAllTabBars();
  refreshAllMessageVisibility(); // 이제 display 토글이 아니라 실제 DOM 분리/재부착(아래 참고)을 수행한다.

  // [v0.4.1] 탭 전환 자체는 chatlog-prune의 추가 로딩을 유발하지 않는다(스크롤 이벤트로만
  // 트리거됨). 그래서 캐시/DOM 어디에도 없는 과거 채널 메시지(예: 메시지가 드문 채널)는
  // 이 호출이 없으면 사용자가 우연히 다른 탭에서 스크롤해줄 때까지 영영 안 나타난다.
  // prune의 공개 renderBatch() API를 대신 호출해 정상 경로로 채워준다(아래 함수 설명 참고).
  await ensureChannelMessagesLoaded(normalized);

  // [버그 C 수정] 예전에는 탭 전환 시 무조건 scrollBottom()으로 맨 아래로 내렸다(그 위의
  // "스크롤 위치가 엉뚱한 곳을 가리키는" 문제를 고치기 위한 임시방편이었음). 이제는
  // captureScrollPositions()로 기억해둔 이 채널의 마지막 스크롤 위치가 있으면 그 위치로
  // 복원하고, 처음 보는 채널일 때만 기존처럼 맨 아래로 이동한다(restoreScrollPositions
  // 내부에서 처리 — 높이가 채널마다 다른 문제는 "채널별로 기억"하는 것 자체로 해결됨).
  restoreScrollPositions(normalized);
}

export function getMessageChannelId(message) {
  return message.getFlag(MODULE_ID, "channelId") || MAIN_CHANNEL_ID;
}

/**
 * [버그 1] 채널별 "마지막 대사 상태" 복원을 위한 조회 헬퍼.
 * 별도의 캐시를 직접 들고 있지 않고, 이 클라이언트가 이미 whisper로 수신해 로컬에 갖고
 * 있는 game.messages를 최신순으로 훑어 지정한 channelId(메인 탭은 MAIN_CHANNEL_ID)에
 * 속하는 가장 최근 메시지를 반환한다. game.messages는 새로고침/재접속 후에도 월드
 * 히스토리에서 다시 채워지므로, 별도 저장 없이도 그 시점 기준 "마지막 대사"를 그대로
 * 복원할 수 있다. 참여하지 않은 채널의 메시지는 애초에 이 클라이언트로 whisper되지
 * 않아 game.messages에 존재하지 않으므로, 여기서 별도 권한 검사가 필요 없다.
 * 해당 채널에 메시지가 전혀 없으면 null을 반환한다.
 */
export function getLastChannelMessage(channelId) {
  const targetId = channelId || MAIN_CHANNEL_ID;
  const messages = game.messages?.contents ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (getMessageChannelId(messages[i]) === targetId) return messages[i];
  }
  return null;
}

// ── [Phase 2] 안읽음 채널 상태 ─────────────────────────────────────────
function getUnreadMap() {
  return game.settings.get(MODULE_ID, "unreadChannels") ?? {};
}

async function setChannelUnread(channelId, unread) {
  const map = { ...getUnreadMap() };
  if (unread) map[channelId] = true;
  else delete map[channelId];
  await game.settings.set(MODULE_ID, "unreadChannels", map);
}

/**
 * 새 메시지가 생성될 때(자기 클라이언트에서 최종 문서를 받는 시점) 호출된다.
 * 지금 보고 있지 않은 채널에 도착한, 본인이 보낸 게 아닌 메시지만 안읽음으로 표시한다.
 * 메인 탭 메시지는 채널 개념이 아니므로 안읽음 대상에서 제외한다.
 */
export function markMessageChannelUnread(message) {
  const channelId = getMessageChannelId(message);
  if (!channelId || channelId === MAIN_CHANNEL_ID) return;

  const authorId = message.author?.id ?? message.user?.id;
  if (authorId === game.user.id) return; // 내가 보낸 메시지로는 스스로 안읽음 표시하지 않음
  if (channelId === getActiveChannelId()) return; // 이미 보고 있는 채널이면 표시할 필요 없음

  const channel = getChannelById(channelId);
  if (!channel || !isUserInChannel(channel, game.user)) return; // 참여 중이 아닌 채널은 표시 안 함
  if (getUnreadMap()[channelId]) return; // 이미 안읽음 표시된 채널은 다시 쓸 필요 없음

  setChannelUnread(channelId, true).then(() => refreshAllTabBars());
}

// ── 탭 이름 표시 ───────────────────────────────────────────────────
/** 탭에 표시할 이름을 4글자로 말줄임한다. 전체 이름은 title 툴팁으로 항상 확인 가능하다. */
function truncateTabName(name) {
  if (name.length <= 4) return name;
  return `${name.slice(0, 4)}…`;
}

// ── 탭바 렌더링 ────────────────────────────────────────────────────
function buildTabButton(channelId, label, fullTitle, isActive, unread, unreadColor) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `ccc-tab${isActive ? " ccc-active" : ""}`;
  btn.title = fullTitle;
  if (channelId) btn.dataset.channelId = channelId;

  if (unread) {
    const dot = document.createElement("span");
    dot.className = "ccc-unread-dot";
    dot.textContent = "*";
    if (unreadColor) dot.style.color = unreadColor;
    btn.append(dot);
  }

  const labelEl = document.createElement("span");
  labelEl.className = "ccc-tab-label";
  labelEl.textContent = label;
  btn.append(labelEl);

  return btn;
}

function renderTabBarContent(container) {
  // 재렌더될 때마다(탭 전환/채널 변경마다) 새 ResizeObserver/MutationObserver를 만들기 때문에,
  // 이전 렌더에서 붙여둔 옵저버를 먼저 끊어줘야 세션이 길어져도 옵저버가 계속 쌓이지 않는다
  // (container 자체는 tabBarContainers에 남아 계속 재사용되므로 매번 정리 필요).
  container._cccObservers?.forEach((observer) => observer.disconnect());
  container._cccObservers = [];

  container.innerHTML = "";
  const channels = getVisibleChannelsForCurrentUser();
  const activeId = getActiveChannelId();
  const unreadMap = getUnreadMap();
  const unreadColor = game.settings.get(MODULE_ID, "unreadIndicatorColor") || "";
  const fontColor = game.settings.get(MODULE_ID, "tabFontColor") || "";
  const bgColor = game.settings.get(MODULE_ID, "tabBackgroundColor") || "";

  if (fontColor) container.style.setProperty("--ccc-tab-font-color", fontColor);
  else container.style.removeProperty("--ccc-tab-font-color");

  if (bgColor) container.style.setProperty("--ccc-tab-bg-color", bgColor);
  else container.style.removeProperty("--ccc-tab-bg-color");

  // "+" 채널 관리 버튼. GM 전용 기능이지만, 스펙에 따라 일반 유저에게도 레이아웃(자리/모양)은
  // 동일하게 보여주고 클릭만 막는다(클래스로 pointer-events만 제거, disabled 속성은 브라우저마다
  // 다르게 흐려 보일 수 있어 사용하지 않음 — 그래야 GM 화면과 시각적으로 완전히 동일하다).
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "ccc-tab ccc-add";
  addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
  if (game.user.isGM) {
    addBtn.title = "채팅 채널 관리";
    addBtn.addEventListener("click", () => ChannelManagerApp.open());
  } else {
    addBtn.classList.add("ccc-inert");
  }
  container.append(addBtn);

  // [Phase 2] 오버플로우 페이지 이동 버튼(왼쪽). 실제 표시 여부는 updateOverflowNav()가 결정한다.
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "ccc-tabbar-nav ccc-tabbar-prev";
  prevBtn.innerHTML = '<i class="fa-solid fa-angle-left"></i>';
  prevBtn.title = "이전 탭";
  container.append(prevBtn);

  const viewport = document.createElement("div");
  viewport.className = "ccc-tabbar-viewport";
  const track = document.createElement("div");
  track.className = "ccc-tabbar-track";
  viewport.append(track);
  container.append(viewport);

  const mainBtn = buildTabButton(MAIN_CHANNEL_ID, "메인", "메인", activeId === MAIN_CHANNEL_ID, false, unreadColor);
  mainBtn.addEventListener("click", () => setActiveChannel(MAIN_CHANNEL_ID));
  track.append(mainBtn);

  for (const channel of channels) {
    const btn = buildTabButton(
      channel.id,
      truncateTabName(channel.name),
      channel.name,
      activeId === channel.id,
      !!unreadMap[channel.id],
      unreadColor
    );
    btn.addEventListener("click", () => setActiveChannel(channel.id));
    track.append(btn);
  }

  // [Phase 2] 오버플로우 페이지 이동 버튼(오른쪽).
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "ccc-tabbar-nav ccc-tabbar-next";
  nextBtn.innerHTML = '<i class="fa-solid fa-angle-right"></i>';
  nextBtn.title = "다음 탭";
  container.append(nextBtn);

  prevBtn.addEventListener("click", () => scrollTabPage(viewport, -1));
  nextBtn.addEventListener("click", () => scrollTabPage(viewport, 1));

  updateOverflowNav(viewport, prevBtn, nextBtn);
  observeOverflow(container, viewport, prevBtn, nextBtn);
}

/** 재렌더 시 정리할 수 있도록 옵저버를 container에 등록해둔다. */
function trackObserver(container, observer) {
  container._cccObservers ??= [];
  container._cccObservers.push(observer);
}

/** 뷰포트 폭만큼(한 페이지) 좌우로 스크롤한다. */
function scrollTabPage(viewport, direction) {
  viewport.scrollBy({ left: direction * viewport.clientWidth * 0.9, behavior: "smooth" });
}

/** 실제로 넘치는 만큼만 좌/우 이동 버튼을 보여준다. */
function updateOverflowNav(viewport, prevBtn, nextBtn) {
  const hasOverflow = viewport.scrollWidth > viewport.clientWidth + 1;
  prevBtn.style.display = hasOverflow && viewport.scrollLeft > 0 ? "" : "none";
  const maxScroll = viewport.scrollWidth - viewport.clientWidth;
  nextBtn.style.display = hasOverflow && viewport.scrollLeft < maxScroll - 1 ? "" : "none";
}

/**
 * 탭 개수/이름 변경이나 창 크기 변경으로 오버플로우 상태가 바뀔 때마다 버튼 표시를 갱신한다.
 * 생성한 ResizeObserver는 renderTabBarContent가 다시 호출될 때(맨 위의 정리 로직으로) 끊긴다 —
 * container 자체가 DOM에서 완전히 제거되는 경우(팝아웃 창 닫기 등)는 다음 refreshAllTabBars() 때
 * tabBarContainers 필터링으로 걸러지므로 별도 감시가 필요 없다.
 */
function observeOverflow(container, viewport, prevBtn, nextBtn) {
  const update = () => updateOverflowNav(viewport, prevBtn, nextBtn);
  viewport.addEventListener("scroll", update, { passive: true });

  const resizeObserver = new ResizeObserver(update);
  resizeObserver.observe(viewport);
  trackObserver(container, resizeObserver);
}

export function refreshAllTabBars() {
  tabBarContainers = tabBarContainers.filter((el) => el.isConnected);
  tabBarContainers.forEach((el) => renderTabBarContent(el));
}

/**
 * 코어 채팅 로그(사이드바 탭, 팝아웃 창 포함)가 렌더될 때마다 탭바를 삽입한다.
 * 템플릿 자체를 수정하지 않고 훅 기반으로 DOM만 추가하는 최소 침습 방식
 * (과거 사이드바 전체 실종 사고 전례 때문에 신중하게 접근).
 */
export function insertTabBar(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  // renderChatLog는 (재)렌더될 때마다 발생하므로, 이미 감시 중인 .chat-log라도
  // 매번 안전하게 다시 확인한다(watchChatLogInsertions 내부에서 중복 등록은 막아줌).
  const chatLogEl = root.querySelector(".chat-log");
  watchChatLogInsertions(chatLogEl);

  // [v0.4.1] ensureChannelMessagesLoaded()가 나중에 이 컨테이너에 대응하는 ChatLog(또는
  // chatlog-prune 서브클래스) 인스턴스를 찾아 renderBatch()를 호출할 수 있도록 등록해둔다.
  if (chatLogEl && app) chatAppByLogElement.set(chatLogEl, app);

  // [버그 A 수정] 새로고침 직후처럼 "활성 채널이 그대로인" 상태에서는 setActiveChannel()의
  // 얼리리턴(if (getActiveChannelId() === normalized) return;) 때문에 refreshAllMessageVisibility()가
  // 한 번도 호출되지 않았다. 그 사이 core(+chatlog-prune)가 채워넣은 초기 배치 메시지는
  // renderChatMessageHTML 훅(applyChannelVisibility)이 채널 정보만 마킹할 뿐 실제로 숨기지는
  // 않고, watchChatLogInsertions의 MutationObserver도 "이 시점 이후" 삽입만 감지하므로 이미
  // DOM에 붙어있던 초기 배치는 감지망 밖이었다 — 그 결과 모든 채널의 메시지가 뒤섞여 보였다.
  // renderChatLog 훅(=여기)은 core가 초기 배치 렌더를 끝낸 뒤에 실행되므로, 여기서 한 번
  // 명시적으로 필터링을 돌려주면 새로고침 직후에도 항상 활성 채널 기준으로 걸러진 상태로
  // 시작한다. refreshAllMessageVisibility는 idempotent라 매 렌더마다 다시 불러도 안전하다.
  refreshAllMessageVisibility();
  if (chatLogEl) ensureChannelMessagesLoaded(getActiveChannelId());

  const existing = root.querySelector(".ccc-tabbar");
  if (existing) {
    renderTabBarContent(existing);
    return;
  }

  const chatForm = root.querySelector("#chat-form") ?? root.querySelector("form.chat-form");
  const container = document.createElement("div");
  container.className = "ccc-tabbar";
  renderTabBarContent(container);

  if (chatForm) chatForm.before(container);
  else root.append(container); // 폴백: 예상 구조가 아니면 맨 끝에 추가(레이아웃 파손 방지 우선)

  tabBarContainers.push(container);
}

/**
 * .chat-log 컨테이너에 새 메시지 <li>가 삽입되는 순간(코어의 일반적인 신규 메시지 append든,
 * chatlog-prune의 배치 prepend/append든 상관없이)을 MutationObserver로 감지해서, 활성
 * 채널이 아닌 메시지면 즉시 떼어낸다.
 *
 * renderChatMessageHTML 훅 시점에는 그 요소가 아직 실제로 DOM에 붙기 전이라(누가, 언제
 * 붙이는지는 호출자 쪽 로직이라 우리가 알 수 없음) 그 시점에 remove()를 호출해도 의미가
 * 없다 — 잠시 후 호출자가 그 노드 레퍼런스를 그대로 append/prepend 해버리면 도로 붙는다.
 * 그래서 "실제로 DOM에 붙는 순간"을 이 옵저버로 직접 포착한다.
 *
 * MutationObserver 콜백은 마이크로태스크로 실행되어, 이 삽입을 일으킨 동기 코드(예:
 * chatlog-prune이 prepend 직후 같은 동기 블록에서 style.display를 검사하는 부분)보다
 * 항상 나중에 실행된다 — 그래서 그 판정 시점까지는 style.display가 우리가 손대지 않은
 * 기본값(=보임)으로 유지되고, 실제 분리는 그 판정이 끝난 뒤 이 콜백에서 이뤄진다.
 */
function watchChatLogInsertions(chatLogEl) {
  if (!chatLogEl || observedChatLogs.has(chatLogEl)) return;
  observedChatLogs.add(chatLogEl);

  const observer = new MutationObserver((mutations) => {
    const activeId = getActiveChannelId();
    for (const mutation of mutations) {
      const container = mutation.target; // 이 옵저버를 .observe()한 바로 그 .chat-log
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement) || !node.classList?.contains("chat-message")) continue;
        // resolveMessageChannelId가 dataset을 못 찾으면 message flag에서 복구해준다
        // (renderChatMessageHTML 훅이 이 요소에 대해 이미 실행됐다면 dataset은 채워져 있음).
        const channelId = resolveMessageChannelId(node);
        if (channelId !== activeId) detachMessageElement(container, node, channelId);
      }
    }
  });
  observer.observe(chatLogEl, { childList: true });
}

/**
 * 비활성 채널 메시지 요소를 DOM에서 떼어내 해당 컨테이너 전용 캐시에 보관한다.
 * channelId를 호출부가 이미 계산해뒀다면 넘겨받아 재계산을 생략한다(성능 개선,
 * watchChatLogInsertions의 MutationObserver 콜백처럼 channelId를 모르는 호출부는
 * 생략하면 기존처럼 내부에서 다시 계산한다).
 */
function detachMessageElement(container, root, channelId) {
  if (!root.isConnected) return;
  const messageId = root.dataset.messageId;
  if (!messageId) return;
  const resolvedChannelId = channelId ?? resolveMessageChannelId(root);
  getContainerCache(container).set(messageId, { element: root, channelId: resolvedChannelId });
  root.remove();
}

// [v0.4.1] 과거의 reattachMessageElement(메시지 하나마다 container.querySelector로 삽입
// 위치를 매번 새로 찾던 O(재부착 개수 × 컨테이너 내 메시지 수) 구현)는 제거했다. 동일한
// 역할은 이제 refreshAllMessageVisibility() 안의 index 기반 병합 삽입이 대신한다.

// ── 메시지 표시 격리(탭 필터링) + whisper 시각 요소 정리 ────────────
/**
 * 코어 Foundry는 whisper가 걸린 메시지에 자동으로
 *  1) <li class="chat-message ... whisper ...">처럼 "whisper" 클래스를 붙여 전용 배경/테두리 스타일을 입히고,
 *  2) 수신자 이름을 보여주는 요소(버전에 따라 selector가 다를 수 있음, 아래 WHISPER_RECIPIENT_SELECTORS 참고)를 렌더링한다.
 * 채널 기능은 whisper를 격리 수단으로만 쓰고 "보이는 방식은 공개 메시지와 완전히 동일해야 한다"는 요구사항이 있으므로,
 * 우리 channelId flag가 붙은 메시지에 한해서만 이 시각적 표시를 지워서 메인탭 메시지와 구분이 안 가게 만든다.
 * (진짜 개인 귓속말은 channelId flag가 없으므로 이 처리를 타지 않고 기존 표시를 그대로 유지한다.)
 *
 * 주의: WHISPER_RECIPIENT_SELECTORS는 Foundry 코어 채팅 템플릿의 실제 마크업을 기준으로 한 것으로,
 * 코어 버전에 따라 클래스명이 다를 수 있다. 실제 환경에서 "To ○○, ○○" 같은 문구가 여전히 보인다면
 * 개발자도구(F12)로 해당 요소의 class를 확인해 이 배열에 추가해야 한다.
 */
const WHISPER_RECIPIENT_SELECTORS = [
  ".whisper-to",
  ".message-metadata .whisper-to",
  ".message-header .whisper-to",
  ".message-metadata .whisper-recipients",
  ".whisper-recipients"
];

function stripWhisperCosmetics(root) {
  root.classList.remove("whisper");
  root.classList.add("ccc-channel-message");

  for (const selector of WHISPER_RECIPIENT_SELECTORS) {
    root.querySelectorAll(selector).forEach((el) => el.remove());
  }

  // 폴백 1: 위 셀렉터 목록은 확인 가능한 문서/코드로 검증한 것이 아니라 과거 버전 관례를
  // 참고해 추정한 값이다(실제 V13 클라이언트에서 F12로 검증 필요, 인계 문서 체크리스트 참고).
  // 정확한 클래스명이 다를 경우를 대비해, 헤더/메타데이터 영역 안에서 클래스명에
  // "whisper"가 포함된 나머지 요소도 함께 제거한다(범위를 헤더/메타데이터로 한정해
  // 본문(.message-content)이나 다른 모듈 요소를 잘못 지우지 않도록 방어).
  root
    .querySelectorAll('.message-header [class*="whisper"], .message-metadata [class*="whisper"]')
    .forEach((el) => el.remove());

  // 폴백 2: 클래스명 기반 탐지가 전부 빗나가는 코어 버전에 대비해, 헤더/메타데이터
  // 영역 안의 "짧은 리프 요소" 중 "To 수신자,수신자..." 형태로 시작하는 텍스트를 가진
  // 것을 수신자 표시로 간주해 제거한다. 오탐 방지를 위해 자식 요소가 없는 리프 노드,
  // 80자 이하 텍스트로만 범위를 좁힌다.
  root.querySelectorAll(".message-header *, .message-metadata *").forEach((el) => {
    if (el.children.length > 0) return; // 리프 요소만 대상
    const text = (el.textContent || "").trim();
    if (text.length > 0 && text.length <= 80 && /^to\s+\S/i.test(text)) el.remove();
  });
}

/**
 * ── 서드파티 모듈이 message-content 안에 심는 "비공개" 라벨 제거 ──────────
 * 실사용 중 발견: 클래스명 `chat-portrait-*`를 쓰는 어떤 다른 모듈(추정: 채팅 초상화/이름
 * 표시 기능을 가진 MRKB 계열 등, 극장 모듈의 `ctp-` 접두사와는 무관함)이 message.whisper를
 * 직접 확인해서 "비공개 굴림 (나와 GM만)" 같은 문구를 `<h4 class="chat-portrait-text-content-name-*">`
 * 안의 `<span class="chat-portrait-indicator-*">`로 본문(.message-content) 안에 삽입한다.
 * [DND5e 환경에서 확인] 이 접미사(`-generic`, `-dnd5e` 등)는 시스템마다 달라진다 — 처음엔
 * `-generic`만 봤는데 DND5e에서는 `-dnd5e`로 나타났다. 앞으로 다른 시스템에서 또 다른
 * 접미사가 나올 수 있으므로, 아래에서는 접두사만 고정한 부분일치 셀렉터로 전부 잡는다.
 * 이건 Foundry 코어 whisper 마크업이 아니라서 stripWhisperCosmetics()의 헤더/메타데이터 스코프
 * 밖에 있고, 그 모듈은 우리 channelId flag를 알지 못하므로 항상 "비공개"로 표시한다.
 *
 * applyChannelVisibility()에서 채널 메시지(channelId flag 있음)에 대해서만 호출되므로,
 * 진짜 개인 귓속말에는 영향을 주지 않는다.
 */
function stripThirdPartyWhisperIndicators(root) {
  // [수정] Chat Portrait 계열 모듈이 클래스명에 시스템별 접미사를 붙이는 것으로 실사용 중
  // 확인됨(-generic 뿐 아니라 -dnd5e 등도 존재). 접두사만 고정이므로 부분일치 셀렉터로
  // 모든 시스템 변형을 한 번에 잡는다.
  root.querySelectorAll('[class*="chat-portrait-indicator-"]').forEach((indicator) => {
    // 라벨을 감싸는 h4(이름 표시용 h4를 재활용해 배지만 넣은 것)가 있으면 h4째로 제거해
    // 빈 h4가 남아 불필요한 여백/겹침이 생기는 것을 방지한다.
    const host = indicator.closest('[class*="chat-portrait-text-content-name-"]') ?? indicator;
    host.remove();
  });

  // 폴백(DND5e 환경 실사용 중 확인): 위 클래스 패턴과도 다르게 나타나는 경우를 대비해
  // 텍스트 기반으로도 탐지한다.
  // [버그 수정] 이전 버전은 /^(비공개|private)\b/i를 썼는데, \b(단어 경계)는 ASCII
  // word문자([A-Za-z0-9_])만 "단어"로 취급해 한글에는 경계가 성립하지 않는다 — "비공개"
  // 뒤에 공백이 와도 양쪽 다 "비단어"라 \b가 매치되지 않아 한글 문구가 전혀 안 걸러지고
  // 있었다. 한글은 "비공개" 뒤에 공백/괄호가 오는지로, 영문은 실제 단어 경계(\b)로 각각
  // 확인하도록 분리했다.
  root.querySelectorAll("h1, h2, h3, h4, h5, h6, span, div, p, label").forEach((el) => {
    if (el.children.length > 0) return; // 리프 요소만 대상
    const text = (el.textContent || "").trim();
    if (text.length === 0 || text.length > 40) return;
    if (/^비공개[\s(]/.test(text) || /^private\b/i.test(text)) el.remove();
  });
}

/**
 * stripThirdPartyWhisperIndicators를 "지금 한 번"이 아니라 root의 DOM 변화를 잠깐
 * 지켜보면서 라벨이 나타날 때마다 다시 지운다.
 *
 * 원인(실사용 중 확인): renderChatMessageHTML 훅은 같은 메시지에 대해 여러 모듈의 핸들러가
 * "등록된 순서대로" 실행된다. 우리 모듈의 핸들러가 그 라벨을 삽입하는 서드파티 모듈의
 * 핸들러보다 먼저 실행되면(모듈 로드 순서는 우리가 통제할 수 없음), 우리가 지우는 시점엔
 * 아직 라벨이 없어서 지울 게 없고, 그 직후 서드파티 모듈이 라벨을 삽입해버려 화면에 그대로
 * 남는다 — 극장 모듈의 "빈 h4" 문제와 동일한 종류의 타이밍 이슈(그쪽의
 * watchAndApplyEmptyContentHeaderFix와 같은 해법 적용).
 */
function watchAndStripThirdPartyWhisperIndicators(root) {
  stripThirdPartyWhisperIndicators(root); // 이미 삽입되어 있는 경우(대부분) 즉시 반영.

  const observer = new MutationObserver(() => stripThirdPartyWhisperIndicators(root));
  observer.observe(root, { childList: true, subtree: true });
  // 메시지 DOM은 렌더 직후 금방 안정되므로, 몇 초 뒤엔 감시를 끊어 옵저버가 무한정 쌓이지 않게 한다.
  setTimeout(() => observer.disconnect(), 3000);
}

function applyChannelVisibility(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  const msgChannelId = getMessageChannelId(message);
  root.dataset.cccChannelId = msgChannelId;

  // 채널 메시지(channelId flag 있음)만 whisper 시각 표시를 지운다. 메인탭의 진짜 개인
  // 귓속말(flag 없음)은 이 처리를 건너뛰어 기존 표시를 그대로 유지한다.
  if (msgChannelId !== MAIN_CHANNEL_ID) {
    try {
      stripWhisperCosmetics(root);
      watchAndStripThirdPartyWhisperIndicators(root);
    } catch (err) {
      console.error("[Chat Channels] whisper 시각 요소 정리 중 오류:", err);
    }
  }

  // [v0.4.0] 여기서는 더 이상 display를 건드리지 않는다(위쪽 큰 주석 참고). 실제 DOM
  // 부착 여부는 watchChatLogInsertions()의 MutationObserver가, 이 요소가 실제로
  // .chat-log에 삽입되는 순간을 감지해서 처리한다.
}

/**
 * 탭 전환 시 호출된다. 지금 DOM에 붙어있는 메시지 중 새 활성 채널이 아닌 것은 떼어
 * 캐시로 보내고, 캐시에 있던 새 활성 채널 메시지는 원래 시간 순서에 맞게 다시 붙인다.
 * 사이드바 + 팝아웃 등 현재 렌더돼 있는 .chat-log 컨테이너 전부에 대해 수행한다.
 *
 * [v0.4.1 성능 개선] 이전 버전은 재부착할 메시지 하나마다 container.querySelector()로
 * "자신보다 뒤에 오는 메시지"를 매번 처음부터 다시 찾았다(재부착 개수 × 컨테이너 내
 * 메시지 수에 가까운 비용). 지금은:
 *   1) game.messages 전체를 한 번만 훑어 messageId -> 순서 index 맵을 만들고,
 *   2) 지금 DOM에 남아있는(활성 채널) 노드들도 한 번만 훑어 index순 배열을 만든 뒤,
 *   3) 재부착 후보(캐시에서 꺼낸 것들)를 index 오름차순으로 정렬해 위 배열과
 *      포인터 하나로 병합(merge)한다 — 포인터가 앞으로만 이동하므로 전체가
 *      한 번의 병합 패스(O(n+m))로 끝난다. 같은 삽입 지점(anchor)에 연속으로
 *      들어갈 메시지는 DocumentFragment로 모았다가 한 번에 삽입해 리플로우도 줄인다.
 *
 * [v0.4.1 추가] 캐시에 너무 많은 메시지가 쌓여 있을 때(예: 다른 탭을 오래 보다가
 * 메시지 많은 채널로 돌아올 때) 전부 한꺼번에 되붙이면 그 자체로 비용이 크고,
 * 곧이어 chatlog-prune이 scrollBottom() 호출 시 50개 초과분을 다시 잘라내는
 * 이중 작업까지 발생한다. 그래서 재부착은 최신 batchSize개까지만 즉시 복원하고,
 * 그보다 오래된 것은 캐시에 남겨둔다 — prune의 정상적인 "위로 스크롤 시 더 로드"
 * 경로로 필요할 때 자연스럽게 채워지게 둔다.
 */
function refreshAllMessageVisibility() {
  const activeId = getActiveChannelId();
  const allMessages = game.messages?.contents ?? [];
  const indexById = new Map();
  allMessages.forEach((m, i) => indexById.set(m.id, i));
  const batchSize = CONFIG.ChatMessage?.batchSize ?? 25;

  document.querySelectorAll(".chat-log").forEach((container) => {
    const cache = getContainerCache(container);

    // 1) 현재 DOM 자식을 한 번 훑으며, 비활성 채널 메시지는 즉시 떼어내고
    //    활성 채널 메시지는 순서 판단용 배열(keptWithIdx)에 모아둔다.
    //    라이브 컬렉션을 순회하며 동시에 제거하면 인덱스가 밀릴 수 있으므로
    //    먼저 배열 스냅샷을 뜬다.
    const keptWithIdx = [];
    Array.from(container.children).forEach((root) => {
      if (!(root instanceof HTMLElement) || !root.classList.contains("chat-message")) return;
      const channelId = resolveMessageChannelId(root);
      if (channelId !== activeId) {
        detachMessageElement(container, root, channelId);
        return;
      }
      const messageId = root.dataset.messageId;
      keptWithIdx.push({ node: root, idx: indexById.get(messageId) ?? Infinity });
    });
    keptWithIdx.sort((a, b) => a.idx - b.idx);

    // 2) 캐시에서 활성 채널 후보를 추려 index 오름차순 정렬. 최근 batchSize개를
    //    초과하면 오래된 쪽은 이번엔 건너뛰고 캐시에 남겨둔다(위 설명 참고).
    const candidates = [];
    for (const [messageId, cached] of cache.entries()) {
      if (cached.channelId !== activeId) continue;
      candidates.push({ messageId, element: cached.element, idx: indexById.get(messageId) ?? -1 });
    }
    candidates.sort((a, b) => a.idx - b.idx);
    const toReattach = candidates.length > batchSize ? candidates.slice(candidates.length - batchSize) : candidates;

    // 3) keptWithIdx와 toReattach를 index 기준으로 병합 삽입. 포인터(ki)는 항상
    //    앞으로만 이동하므로 전체 컨테이너를 재조회하지 않는다.
    let ki = 0;
    let currentAnchor; // undefined = 아직 미설정, null = "맨 끝에 붙임"
    let runFragment = null;
    const flushRun = () => {
      if (!runFragment) return;
      if (currentAnchor) currentAnchor.before(runFragment);
      else container.append(runFragment);
      runFragment = null;
    };

    for (const cand of toReattach) {
      while (ki < keptWithIdx.length && keptWithIdx[ki].idx < cand.idx) ki++;
      const anchor = ki < keptWithIdx.length ? keptWithIdx[ki].node : null;
      if (anchor !== currentAnchor) {
        flushRun();
        currentAnchor = anchor;
        runFragment = document.createDocumentFragment();
      }
      runFragment.append(cand.element);
      cache.delete(cand.messageId);
    }
    flushRun();
  });
}

/** container(.chat-log) 안에 해당 채널 메시지가 하나라도 이미 렌더돼 있는지 확인한다. */
function channelHasRenderedMessage(container, channelId) {
  return Array.from(container.children).some(
    (el) =>
      el instanceof HTMLElement &&
      el.classList.contains("chat-message") &&
      resolveMessageChannelId(el) === channelId
  );
}

/**
 * [v0.4.1] 탭 전환 시 호출된다. 활성 채널이 캐시/DOM 어디에도 없는데 실제로는
 * 메시지가 존재하는 경우(예: 메시지가 드문 채널), chatlog-prune이 공개하는
 * renderBatch()를 대신 호출해 정상 경로로 더 과거 배치를 불러오게 만든다.
 *
 * 왜 직접 <li>를 렌더링해서 끼워넣지 않는가: chatlog-prune은 이미 렌더한 메시지
 * id를 자체 private Set(#t)으로 추적하고, 그 Set에 없는 메시지만 새로 렌더링한다.
 * 우리가 그 경로를 우회해 직접 넣으면 그 Set에 등록되지 않으므로, 나중에 prune이
 * 같은 구간을 지나가며 "아직 안 그렸다"고 착각해 같은 메시지를 중복으로 렌더링할
 * 위험이 있다. renderBatch()는 prune 내부에서 진행 중 여부(#a)와 동시성(#u,
 * semaphore)까지 스스로 관리해주므로, 우리가 여러 번 연달아 호출해도 안전하다.
 *
 * 왜 반복 호출이 필요한가: renderBatch()는 "방금 렌더한 것 중 화면에 보이는(=
 * style.display !== 'none') 개수"만 보고 목표치(batchSize) 도달 여부를 판단하며
 * 채널 개념을 전혀 모른다. 한 번에 채워지는 배치가 우연히 다른 채널 메시지들로만
 * 가득 차 목표를 채우고 멈춰버릴 수 있으므로, 우리가 찾는 채널 메시지가 실제로
 * 나타날 때까지(또는 상한 도달까지) 반복 호출한다.
 */
export async function ensureChannelMessagesLoaded(channelId) {
  if (!channelId || channelId === MAIN_CHANNEL_ID) return; // 메인 탭은 항상 코어 기본 배치 안에 있으므로 제외
  if (!getLastChannelMessage(channelId)) return; // 이 채널에 애초에 메시지가 없으면 시도할 필요 없음

  for (const container of Array.from(document.querySelectorAll(".chat-log"))) {
    if (channelHasRenderedMessage(container, channelId)) continue;

    const app = chatAppByLogElement.get(container);
    if (!app || typeof app.renderBatch !== "function") continue; // chatlog-prune 미설치/구버전 등: 손대지 않는다

    const batchSize = CONFIG.ChatMessage?.batchSize ?? 25;
    for (let attempt = 0; attempt < ENSURE_LOAD_MAX_ATTEMPTS; attempt++) {
      try {
        await app.renderBatch(batchSize);
      } catch (err) {
        console.error("[Chat Channels] chatlog-prune renderBatch() 호출 중 오류:", err);
        break; // 실패하면 더 시도하지 않는다(안전 우선)
      }

      // renderBatch가 새로 붙인 노드는 보통 watchChatLogInsertions의 MutationObserver가
      // 이미 비동기로 걸러줬겠지만, 여기서는 판정을 위해 한 번 더 동기적으로 확인한다
      // (idempotent라 중복 호출해도 안전).
      refreshAllMessageVisibility();

      if (channelHasRenderedMessage(container, channelId)) break;
    }
  }
}

/**
 * [보강 패치] 채널 필터링은 원래 renderChatMessageHTML 훅이 채워둔
 * root.dataset.cccChannelId만 읽었다. 그런데 다른 모듈(예: 채팅 로그 DOM을 자체적으로
 * 정리/재사용하는 성능 최적화 모듈)이 이 훅을 거치지 않고 메시지 <li>를 DOM에 다시
 * 끼워넣으면, dataset이 채워지지 않은 채로 나타날 수 있다. 이런 경우를 "메인 채널"로
 * 그냥 단정해버리면 실제로는 다른 채널 메시지였던 것이 메인 탭에 새거나, 반대로 원래
 * 채널 탭에서 사라지는 오류가 생긴다.
 *
 * dataset이 비어있는(=이 요소를 아직 한 번도 처리해본 적 없는) 경우에만, 코어가 항상
 * 붙여주는 data-message-id로 실제 ChatMessage 문서를 찾아 flag를 직접 읽는 폴백을 탄다.
 * 문서를 찾으면 그 값으로 dataset을 다시 채워 다음 번부터는 폴백 없이 빠르게 처리된다.
 * 문서조차 못 찾는 극히 예외적인 경우(메시지가 실제로 삭제된 경우 등)에만 기존처럼
 * 메인 채널로 취급한다.
 */
function resolveMessageChannelId(root) {
  if ("cccChannelId" in root.dataset) return root.dataset.cccChannelId || MAIN_CHANNEL_ID;

  const messageId = root.dataset.messageId;
  const message = messageId ? game.messages.get(messageId) : null;
  if (!message) return MAIN_CHANNEL_ID;

  const channelId = getMessageChannelId(message);
  root.dataset.cccChannelId = channelId;
  console.warn(
    "[Chat Channels] 채널 정보가 없는 채팅 메시지 요소를 발견해 flag에서 복구했습니다. " +
    "다른 모듈이 이 메시지 DOM을 훅 없이 재삽입했을 가능성이 있습니다.",
    message.id
  );
  return channelId;
}

/**
 * 메시지가 실제로 삭제됐을 때(deleteChatMessage) 호출한다. 그 메시지가 마침 비활성
 * 채널이라 캐시에 분리 보관돼 있었다면, 다시는 재부착되지 않도록(어차피 문서 자체가
 * 없어졌으므로) 모든 컨테이너 캐시에서 지워 메모리에 계속 남지 않게 한다.
 */
export function forgetDetachedMessage(messageId) {
  document.querySelectorAll(".chat-log").forEach((container) => {
    detachedByContainer.get(container)?.delete(messageId);
  });
}

export { applyChannelVisibility, refreshAllMessageVisibility };
