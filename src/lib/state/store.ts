import { reactive, watch, type UnwrapNestedRefs } from '@vue/reactivity';
import type { Readable } from 'svelte/store';
const instances = new Map<string, unknown>();
export function defineStore<T extends object>(
  id: string,
  setup: () => T,
): () => UnwrapNestedRefs<T> {
  return () => {
    if (!instances.has(id)) instances.set(id, reactive(setup()));
    return instances.get(id) as UnwrapNestedRefs<T>;
  };
}
export function observe<T>(select: () => T): Readable<T> {
  return {
    subscribe(run) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = watch(select, run, {
        immediate: true,
        deep: 2,
        scheduler: (job) => {
          if (timer === undefined)
            timer = setTimeout(() => {
              timer = undefined;
              job();
            }, 16);
        },
      });
      return () => {
        clearTimeout(timer);
        stop();
      };
    },
  };
}
export function createPinia() {
  return {};
}
export function setActivePinia(_: unknown) {
  instances.clear();
}
