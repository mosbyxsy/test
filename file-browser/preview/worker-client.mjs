/** 带取消、超时和错误收敛的 Worker RPC；超时会真正终止 Worker。 */
export function createWorkerClient(url, { signal, timeoutMs = 15000, WorkerClass = Worker } = {}) {
  signal?.throwIfAborted();
  const worker = new WorkerClass(url);
  let sequence = 0;
  let stopped = false;
  const pending = new Map();
  function dispose(reason = new DOMException('解析已取消', 'AbortError')) {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    signal?.removeEventListener('abort', abort);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    pending.clear();
  }
  function abort() { dispose(signal.reason); }
  signal?.addEventListener('abort', abort, { once: true });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    dispose(new Error('文档解析组件失败，请重试或下载后打开。'));
  };
  function send(data, transfer = []) {
    if (stopped) return Promise.reject(new Error('解析任务已停止，请重新打开文件。'));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => dispose(new Error('解析超过 15 秒，已自动停止，请下载后打开或重试。')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ ...data, id }, transfer); } catch (error) { dispose(error); }
    });
  }
  return { send, dispose };
}
