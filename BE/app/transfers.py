"""Shared cutout slots and the current batch's interactive requests."""

from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from threading import Lock, RLock


class CutoutQueue:
    def __init__(self, slots: int):
        self.slots = slots
        self.pool = ThreadPoolExecutor(max_workers=slots, thread_name_prefix="cutout")
        self.lock = Lock()
        self.waiting = OrderedDict()
        self.workers = 0

    def submit(self, work, *args, priority=False):
        future = Future()
        with self.lock:
            self.waiting[future] = (work, args)
            if priority:
                self.waiting.move_to_end(future, last=False)
            if self.workers < self.slots:
                self.workers += 1
                self.pool.submit(self._work)
        return future

    def promote(self, future):
        with self.lock:
            if future in self.waiting:
                self.waiting.move_to_end(future, last=False)

    def _work(self):
        while True:
            with self.lock:
                if not self.waiting:
                    self.workers -= 1
                    return
                future, (work, args) = self.waiting.popitem(last=False)
            if future.set_running_or_notify_cancel():
                try:
                    future.set_result(work(*args))
                except BaseException as exc:
                    future.set_exception(exc)

    def close(self):
        self.pool.shutdown(wait=True)


class PriorityLoads:
    """Hand a click to the active dispatcher or retain it across batch transitions."""

    def __init__(self):
        self.lock = RLock()
        self.waiting = {}
        self.dispatch = None

    def request(self, obs_id):
        with self.lock:
            if self.dispatch is None:
                self.waiting[obs_id] = None
            else:
                self.dispatch(obs_id)

    def take_waiting(self):
        with self.lock:
            ids = list(self.waiting)
            self.waiting.clear()
            return ids
