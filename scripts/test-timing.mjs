export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function createManualScheduler() {
  let sequence = 0;
  let elapsed = 0;
  const tasks = new Map();

  const schedule = (callback, delay = 0, repeat = false) => {
    const handle = {
      id: ++sequence,
      unref() {
        return handle;
      },
    };
    tasks.set(handle.id, {
      callback,
      delay: Math.max(0, Number(delay) || 0),
      dueAt: elapsed + Math.max(0, Number(delay) || 0),
      repeat,
      handle,
    });
    return handle;
  };
  const clear = (handle) => {
    if (handle && typeof handle === "object" && "id" in handle) tasks.delete(handle.id);
  };

  return {
    setTimeout(callback, delay) {
      return schedule(callback, delay, false);
    },
    clearTimeout: clear,
    setInterval(callback, delay) {
      return schedule(callback, delay, true);
    },
    clearInterval: clear,
    pendingCount() {
      return tasks.size;
    },
    async runNext() {
      const task = [...tasks.values()].sort(
        (left, right) => left.dueAt - right.dueAt || left.handle.id - right.handle.id,
      )[0];
      if (!task) throw new Error("No scheduled task is pending");
      elapsed = task.dueAt;
      if (task.repeat) task.dueAt += task.delay;
      else tasks.delete(task.handle.id);
      task.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
