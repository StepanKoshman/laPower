// @ts-check
/**
 * @file Temperature ServiceConnect管理及Temperature相关 UI 可见性控制。
 *
 * Source二选一：Local（仪表 HID Temperature）或External TCP。连/断仍只走命令栏按钮。
 */

import { setSeriesVisible } from './chart.js';
import { state } from './state.js';
import { syncTempUI } from './ui/controlbar.js';
import { toast } from './ui/toast.js';

const { invoke } = window.__TAURI__.core;

const DEVICE_HINT = '使用当前Connect仪表报告的Temperature。使用命令栏按钮Connect或Disconnect。';
const EXTERNAL_HINT = 'External TCP Temperature Service，每行一个数值。使用命令栏按钮Connect或Disconnect。';

/** @returns {'device'|'external'} */
export function currentTempSource() {
  return state.settings.tempSource === 'device' ? 'device' : 'external';
}

/** 回显Source控件并显隐 IP/Port。 */
export function syncTempSourceUI() {
  const device = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-source-device'));
  const external = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-source-external'));
  const isDevice = currentTempSource() === 'device';
  if (device) device.checked = isDevice;
  if (external) external.checked = !isDevice;
  const fields = document.getElementById('temp-external-fields');
  if (fields) fields.hidden = isDevice;
  const hint = document.getElementById('temp-source-hint');
  if (hint) hint.textContent = isDevice ? DEVICE_HINT : EXTERNAL_HINT;
}

// ─── Connect / Disconnect ────────────────────────────────────────────────────

let connectingTemp = false;

/** Connect到Temperature Service（Local或 TCP）。 */
export async function connectTempService() {
  if (connectingTemp) return;
  if (currentTempSource() === 'device') {
    if (!state.isConnected) {
      toast.warning('请先ConnectDevice');
      return;
    }
    setTempConnected(true);
    return;
  }

  const ipEl = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-ip'));
  const portEl = /** @type {HTMLInputElement|null} */ (document.getElementById('temp-port'));
  const ip = ipEl?.value || '127.0.0.1';
  const port = Number.parseInt(portEl?.value || '', 10);

  connectingTemp = true;
  try {
    await invoke('connect_temp_service', { ip, port });
    setTempConnected(true);
    state.settings.tempIp = ip;
    state.settings.tempPort = port;
  } catch (e) {
    toast.error(`Temperature ServiceConnect失败: ${e}`);
  } finally {
    connectingTemp = false;
  }
}

/** DisconnectTemperature Service。 */
export async function disconnectTempService() {
  if (currentTempSource() === 'device') {
    setTempConnected(false);
    return;
  }
  try {
    await invoke('disconnect_temp_service');
    setTempConnected(false);
  } catch (e) {
    toast.error(`DisconnectTemperature Service失败: ${e}`);
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * 更新TemperatureConnect状态及 UI。
 * @param {boolean} connected
 */
export function setTempConnected(connected) {
  state.isTempConnected = connected;

  /** @param {string} id @param {boolean} disabled */
  const setDisabled = (id, disabled) => {
    const el = /** @type {HTMLButtonElement|HTMLInputElement|null} */ (document.getElementById(id));
    if (el) el.disabled = disabled;
  };

  setDisabled('temp-ip', connected);
  setDisabled('temp-port', connected);
  setDisabled('temp-source-device', connected);
  setDisabled('temp-source-external', connected);
  syncTempUI(connected);

  if (connected) {
    state.hasTempData = true;
  }

  if (!connected) {
    state.currentTemp = null;
    const rtTemp = document.getElementById('rt-temp');
    if (rtTemp) rtTemp.textContent = '--';
  }

  updateTempUIVisibility();
}

/**
 * 仪表Disconnect时注销「Local」Temperature源。
 *
 * 后端只在 TCP 读取任务里发 `temp-disconnected`，Local源没有可Close的会话，
 * 因此必须由Connect状态变化显式Reset，否则读数会冻结在最后一个值上。
 * External TCP 会话与仪表流相互独立，这里不能碰。
 */
export function resetTempForDevice() {
  if (currentTempSource() !== 'device' || !state.isTempConnected) return;
  setTempConnected(false);
}

// ─── UI visibility ───────────────────────────────────────────────────────────

/** 根据当前是否有Temperature数据来Show/隐藏Temperature相关的 UI 元素。 */
export function updateTempUIVisibility() {
  const showTemp = state.isTempConnected || state.hasTempData;

  const tempCard = document.getElementById('temp-card');
  if (tempCard) tempCard.style.display = showTemp ? 'grid' : 'none';

  const exportWithTemp = document.getElementById('export-with-temp');
  if (exportWithTemp) exportWithTemp.classList.toggle('hidden', !showTemp);
  const overflowExportWithTemp = document.getElementById('overflow-export-with-temp');
  if (overflowExportWithTemp) overflowExportWithTemp.classList.toggle('hidden', !showTemp);

  const showTempContainer = document.getElementById('show-temp-container');
  if (showTempContainer) showTempContainer.style.display = showTemp ? 'flex' : 'none';

  if (state.mainChart) {
    const tempVisible = showTemp && state.settings.showTemp;
    setSeriesVisible(3, tempVisible);
  }
}
