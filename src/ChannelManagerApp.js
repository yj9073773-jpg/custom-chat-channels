import { MODULE_ID, normalizeChannel } from "./module-config.js";
import { refreshAllTabBars } from "./chat-log-ui.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * GM 전용 채널 생성/편집 창 (3-1 스펙).
 * - 전체 선택/해제 체크박스
 * - 채널 이름 입력
 * - 참여 인원 체크박스 목록 (GM은 항상 자동 포함이라 목록에 노출하지 않음)
 * - 기존 채널 목록에서 편집/삭제
 *
 * Phase 1 범위: 기능 동작 위주의 최소 UI. 탭바 오버플로우, 색상 설정 등은 Phase 2에서 다룬다.
 */
export class ChannelManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "custom-chat-channels-manager",
    tag: "div",
    window: {
      title: "채팅 채널 관리",
      icon: "fa-solid fa-comments",
      resizable: true
    },
    position: { width: 420, height: "auto" },
    actions: {
      toggleAllPlayers: ChannelManagerApp.#onToggleAllPlayers,
      editChannel: ChannelManagerApp.#onEditChannel,
      deleteChannel: ChannelManagerApp.#onDeleteChannel,
      saveChannel: ChannelManagerApp.#onSaveChannel
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/src/templates/channel-manager.html` }
  };

  constructor(options = {}) {
    super(options);
    // null이면 "새 채널 생성" 모드, 문자열이면 해당 id 채널을 편집 중.
    this.editingChannelId = null;
    this.pendingName = "";
    this.pendingParticipantIds = new Set();
  }

  static open() {
    if (!ChannelManagerApp._instance) {
      ChannelManagerApp._instance = new ChannelManagerApp();
    }
    ChannelManagerApp._instance.render(true);
    return ChannelManagerApp._instance;
  }

  _getChannels() {
    const raw = game.settings.get(MODULE_ID, "channels") ?? {};
    return Object.values(raw).map((c) => normalizeChannel(c));
  }

  async _prepareContext(_options) {
    const channels = this._getChannels();
    const players = game.users.filter((u) => !u.isGM).map((u) => ({ id: u.id, name: u.name }));

    const allSelected = players.length > 0 && players.every((p) => this.pendingParticipantIds.has(p.id));

    return {
      channels: channels.map((c) => ({ ...c, isEditing: c.id === this.editingChannelId })),
      players: players.map((p) => ({ ...p, checked: this.pendingParticipantIds.has(p.id) })),
      allSelected,
      pendingName: this.pendingName,
      isEditing: this.editingChannelId !== null,
      formTitle: this.editingChannelId !== null ? "채널 편집" : "새 채널 만들기"
    };
  }

  /** 폼을 "새 채널 생성" 상태로 초기화한다. */
  #resetForm() {
    this.editingChannelId = null;
    this.pendingName = "";
    this.pendingParticipantIds = new Set();
  }

  static #onToggleAllPlayers(_event, target) {
    const checked = target.checked;
    const players = game.users.filter((u) => !u.isGM);
    if (checked) players.forEach((p) => this.pendingParticipantIds.add(p.id));
    else this.pendingParticipantIds.clear();

    // 버그 수정(Phase 2): 이 토글도 render()를 다시 호출해 폼을 새로 그리는데, 그 사이
    // 입력 중이던 탭 이름이 pendingName에 반영된 적이 없어 재렌더 시 사라지는 문제가 있었다.
    // 재렌더 직전에 현재 이름 입력값을 pendingName에 먼저 채워 넣어 유지되게 한다.
    const nameInput = this.element.querySelector("form[data-channel-form] [name='channelName']");
    if (nameInput) this.pendingName = nameInput.value;

    this.render();
  }

  static #onEditChannel(_event, target) {
    const channelId = target.closest("[data-channel-id]")?.dataset.channelId;
    if (!channelId) return;

    // 토글: 이미 이 채널을 편집 중인데 연필 아이콘을 또 누르면, "새 채널 만들기" 모드로 되돌아간다
    // ("+새 채널" 버튼이 없어진 대신, 편집 중이던 채널의 연필을 한 번 더 누르는 것으로 대체).
    if (this.editingChannelId === channelId) {
      this.#resetForm();
      this.render();
      return;
    }

    const channel = this._getChannels().find((c) => c.id === channelId);
    if (!channel) return;
    this.editingChannelId = channel.id;
    this.pendingName = channel.name;
    this.pendingParticipantIds = new Set(channel.participantIds);
    this.render();
  }

  static async #onDeleteChannel(_event, target) {
    const channelId = target.closest("[data-channel-id]")?.dataset.channelId;
    if (!channelId) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "채널 삭제" },
      content: "<p>이 채널을 삭제할까요? 채널 내 과거 메시지는 삭제되지 않지만, 이 채널을 활성 탭으로 보고 있던 참여자는 자동으로 메인 탭으로 돌아갑니다.</p>"
    });
    if (!confirmed) return;

    const raw = game.settings.get(MODULE_ID, "channels") ?? {};
    delete raw[channelId];
    await game.settings.set(MODULE_ID, "channels", raw);
    refreshAllTabBars(); // 버그1 수정: updateSetting 훅을 기다리지 않고 저장한 본인 화면은 즉시 갱신

    if (this.editingChannelId === channelId) this.#resetForm();
    this.render();
  }

  static async #onSaveChannel(event) {
    event.preventDefault();
    const form = this.element.querySelector("form[data-channel-form]");
    const nameInput = form.querySelector("[name='channelName']");
    const name = nameInput.value.trim();
    if (!name) {
      ui.notifications.warn("채널 이름을 입력해주세요.");
      return;
    }

    const participantIds = Array.from(
      form.querySelectorAll("[name='participant']:checked")
    ).map((el) => el.value);

    const raw = game.settings.get(MODULE_ID, "channels") ?? {};
    const id = this.editingChannelId ?? foundry.utils.randomID();
    raw[id] = normalizeChannel({ id, name, participantIds });
    await game.settings.set(MODULE_ID, "channels", raw);
    refreshAllTabBars(); // 버그1 수정: 최초 채널 생성 시 createSetting만 발생해 updateSetting 훅을 못 받는 경우까지 포함해, 저장한 본인 화면은 훅과 무관하게 항상 즉시 갱신

    this.#resetForm();
    this.render();
  }
}
