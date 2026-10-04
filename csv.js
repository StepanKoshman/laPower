// @ts-check
/**
 * @file CSV Import / Export。
 *
 * 两个方向都是流式的：Export按块格式化、按块写进后端文件句柄；Import按 4 MiB 分块读出，
 * 零拷贝转交给 Worker 边读边解析。WebView 里从不出现整份文件的字符串，几百 MB 的
 * 1000 / sec记录也能Export、导回。路径由后端的原生对话框决定。
 */

import { syncChartSeries, updateCharts } from './chart.js';
import { yieldToMainThread } from './cooperative.js';
import { formatCsvHeader, snapshotCsvColumns } from './csv-codec.js';
import { formatCsvRangeAsync } from './csv-export.js';
import {
  clearAndResetStats,
  refreshRecordButton,
  stopRecording,
  updateChartEmptyState,
  updateChartRange,
  updateEnergyDisplay,
  updateRealtimeDisplay,
  updateRemainingDisplay,
  updateStatsDisplay,
} from './data.js';
import {
  closeReader,
  closeWriter,
  deleteSpoolRecovery,
  openSpoolRecovery,
  pickExportFile,
  pickImportFile,
  readChunk,
  writeText,
} from './file-io.js';
import { F64_CHUNK_SIZE, F64Col, setChartColumns, state } from './state.js';
import { updateTempUIVisibility } from './temperature.js';
import { ask } from './ui/dialog.js';
import { toast } from './ui/toast.js';

/** 每次写入的行数：Approx 0.5 MB 一块，IPC 次数与单块格式化时长之间的折中。 */
const EXPORT_CHUNK_ROWS = 4096;
/** 超过这个行数 / 字节数时先Hint「正在Export / Import」，免得用户以为没反应。 */
const LARGE_EXPORT_ROWS = 200_000;
const LARGE_IMPORT_BYTES = 16 * 1024 * 1024;

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Export数据为 CSV 文件。
 * @param {boolean} [withTemp=false] - 是否包含Temperature列
 */
export async function exportCSV(withTemp = false) {
  if (state.chartSeries.x.length === 0) {
    toast.warning('没有数据可Export');
    return;
  }

  /** @type {import('./file-io.js').OpenedFile|null} */
  let file = null;
  try {
    file = await pickExportFile(`lapower_data_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  } catch (e) {
    console.error(e);
    toast.error(`Export失败: ${e}`);
    return;
  }
  // Cancel不遍历、格式化或Copy任何列；对话框期间可能Continue录制或换入新数据。
  if (!file) return;
  const cols = state.chartSeries;
  if (cols.x.length === 0) {
    await closeWriter(file.handle, { abort: true }).catch(() => {});
    toast.warning('没有数据可Export');
    return;
  }
  const snapshot = snapshotCsvColumns(cols, {
    withTemp,
    sampleRate: state.dataIntervalMs ?? state.settings.sampleRate,
    startTime: state.lastRecordingStartTime ?? cols.timestamps.at(0) ?? Date.now(),
  });
  if (snapshot.length >= LARGE_EXPORT_ROWS) toast.info(`正在Export ${snapshot.length} rows...`);
  try {
    // 逐块等待写完再格式化下一块：背压留在这里，内存里最多一块文本。
    await writeText(file.handle, formatCsvHeader(snapshot));
    for (let from = 0; from < snapshot.length; from += EXPORT_CHUNK_ROWS) {
      const to = Math.min(snapshot.length, from + EXPORT_CHUNK_ROWS);
      await writeText(file.handle, await formatCsvRangeAsync(snapshot, from, to));
      await yieldToMainThread();
    }
    await closeWriter(file.handle, { sync: true });
    toast.success(`Export成功：${file.name}`);
  } catch (e) {
    console.error(e);
    // 写失败直接退出，不报成功；写了一半的文件删掉，不留下看似完整的残档。
    await closeWriter(file.handle, { abort: true }).catch(() => {});
    toast.error(`Export失败: ${e}`);
  }
}

// ─── Import ──────────────────────────────────────────────────────────────────

let importGeneration = 0;
/** @type {(() => void)|null} */
let cancelActiveImport = null;

/**
 * 把文件按块喂给 Worker：读一块、转交一块、等回执，再读下一块。
 * Worker 负责解码与解析，只有解析出的新列缓冲会零拷贝转回主线程。
 * 每条错误 / Cancel路径都 reject，并终止 Worker。
 * @param {number} handle
 * @param {{signedCurrent: boolean, fallbackStartTime: number}} options
 * @param {number} generation
 */
function parseFileInWorker(handle, options, generation) {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') {
      reject(new Error('此环境不支持 CSV Import Worker'));
      return;
    }
    /** @type {Worker} */
    let worker;
    try {
      worker = new Worker(new URL('./csv-import-worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    /** @type {(() => void)|null} */
    let ackWaiter = null;
    /** @param {Error|null} error @param {unknown} [result] */
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      ackWaiter = null;
      if (cancelActiveImport === cancel) cancelActiveImport = null;
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => finish(new Error('CSV Import已被新任务Cancel'));
    cancelActiveImport = cancel;
    worker.onmessage = (event) => {
      if (generation !== importGeneration) return cancel();
      const message = event.data;
      if (message?.type === 'ready' || message?.type === 'ack') {
        const waiter = ackWaiter;
        ackWaiter = null;
        waiter?.();
      } else if (message?.type === 'done') finish(null, message.result);
      else finish(new Error(message?.error || 'CSV Worker 返回None效结果'));
    };
    worker.onerror = (event) => finish(new Error(event.message || 'CSV Worker execution failed'));
    worker.onmessageerror = () => finish(new Error('CSV Worker data transfer failed'));

    /** 发一条消息并等 Worker 回执。 @param {unknown} message @param {Transferable[]} [transfer] */
    const send = (message, transfer = []) =>
      new Promise((ack) => {
        ackWaiter = () => ack(undefined);
        worker.postMessage(message, transfer);
      });

    (async () => {
      await send({ type: 'begin', options });
      for (;;) {
        if (settled) return;
        if (generation !== importGeneration) return cancel();
        const bytes = await readChunk(handle);
        if (settled) return;
        if (bytes.byteLength === 0) {
          worker.postMessage({ type: 'end' });
          return;
        }
        await send({ type: 'chunk', bytes }, [bytes]);
      }
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/** Reattach F64Col methods to transferred chunks without copying any column. */
function restoreColumns(raw) {
  /** @type {import('./state.js').ChartSeriesColumns} */
  const columns = /** @type {any} */ ({});
  for (const key of /** @type {(keyof import('./state.js').ChartSeriesColumns)[]} */ (Object.keys(raw))) {
    const source = raw[key];
    if (
      !Array.isArray(source._chunks) ||
      !source._chunks.every((chunk) => chunk instanceof Float64Array && chunk.length === F64_CHUNK_SIZE) ||
      !Number.isSafeInteger(source.length) ||
      source.length < 0 ||
      source.length > source._chunks.length * F64_CHUNK_SIZE ||
      source._chunks.length !== Math.ceil(source.length / F64_CHUNK_SIZE)
    )
      throw new Error('CSV Worker 返回None效列缓冲');
    columns[key] = Object.assign(Object.create(F64Col.prototype), source);
  }
  return columns;
}

/** 从已Open的 CSV 句柄Import数据。 */
async function importOpenedFile(
  file,
  generation,
  reportFailure = (error) => {
    toast.error(`Import失败: ${error.message ?? error}`);
  },
) {
  if (!file) return false;
  if (generation !== importGeneration) return false;
  if (file.size >= LARGE_IMPORT_BYTES) toast.info(`正在Import ${file.name}（${(file.size / 1048576).toFixed(0)} MB）…`);
  try {
    const imported = /** @type {ReturnType<import('./csv-import-core.js').computeCsvImport>} */ (
      await parseFileInWorker(
        file.handle,
        {
          signedCurrent: state.settings.signedCurrent,
          fallbackStartTime: Date.now(),
        },
        generation,
      )
    );
    if (generation !== importGeneration) return false;
    const cols = restoreColumns(imported.columns);
    const n = cols.x.length;

    if (state.isRecording || state.chartSeries.timestamps.length > 0) {
      const message = state.isRecording
        ? '当前正在录制，Import CSV 将Stop录制并清除现有记录。\nOK要Continue吗？'
        : '当前已有数据，Import CSV 将清除现有记录。\nOK要Continue吗？';
      const confirmed = await ask(message, { title: '确认Import', kind: 'warning' });
      if (!confirmed || generation !== importGeneration) return false;
    }

    await stopRecording();
    if (generation !== importGeneration) return false;
    clearAndResetStats();
    state.lastRecordingStartTime = imported.startTime;
    setChartColumns(cols);
    state.dataIntervalMs = imported.intervalMs;
    state.stats = imported.stats;
    state.energy.wh = imported.energy.wh;
    state.energy.mah = imported.energy.mah;
    state.energy.lastX = null;
    state.hasTempData = imported.hasTempData;

    updateStatsDisplay();
    updateEnergyDisplay();
    const dataCountEl = document.getElementById('data-count');
    if (dataCountEl) dataCountEl.textContent = String(n);
    updateRemainingDisplay();
    syncChartSeries();
    updateChartRange();
    updateCharts();
    updateChartEmptyState();
    updateTempUIVisibility();
    const last = n - 1;
    updateRealtimeDisplay({
      voltage: cols.voltage.valueAt(last),
      current: cols.current.valueAt(last),
      power: cols.power.valueAt(last),
      temp: cols.temp.valueAt(last),
      dp: cols.dp.valueAt(last),
      dn: cols.dn.valueAt(last),
      cc1: cols.cc1.valueAt(last),
      cc2: cols.cc2.valueAt(last),
    });
    refreshRecordButton();
    toast.success(`成功Import ${n} records`);
    return true;
  } catch (e) {
    if (generation !== importGeneration) return false;
    console.error(e);
    reportFailure(/** @type {Error} */ (e));
    return false;
  } finally {
    void closeReader(file.handle).catch(() => {});
  }
}

/** 从 CSV 文件Import数据。 */
export async function importCSV() {
  const generation = ++importGeneration;
  cancelActiveImport?.();
  /** @type {import('./file-io.js').OpenedFile|null} */
  let file = null;
  try {
    file = await pickImportFile();
    await importOpenedFile(file, generation);
  } catch (e) {
    if (generation !== importGeneration) return;
    console.error(e);
    toast.error(`Import失败: ${/** @type {Error} */ (e).message ?? e}`);
  }
}

/** Recover并清理一份异常退出留下的临时记录；Cancel或失败时保留文件。
 * @param {string} id
 * @param {(message: string) => void} [reportFailure]
 * @returns {Promise<boolean>}
 */
export async function importSpoolRecovery(id, reportFailure = toast.error) {
  const generation = ++importGeneration;
  cancelActiveImport?.();
  let file = null;
  try {
    file = await openSpoolRecovery(id);
    const imported = await importOpenedFile(file, generation, (error) =>
      reportFailure(`Temporary record recovery failed: ${error.message ?? error}`),
    );
    if (!imported || generation !== importGeneration) return false;
    try {
      await deleteSpoolRecovery(id);
    } catch (error) {
      reportFailure(`Record recovered, but temp file cleanup failed. Try deleting: ${error}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(error);
    reportFailure(`Temporary record recovery failed: ${error}`);
    return false;
  }
}
