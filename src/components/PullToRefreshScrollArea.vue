<template>
  <q-pull-to-refresh
    class="pull-to-refresh-scroll-area"
    :disable="disable"
    :scroll-target="scrollTarget"
    @refresh="handleRefresh"
  >
    <q-scroll-area ref="scrollAreaRef" class="pull-to-refresh-scroll-area__scroll">
      <slot />
    </q-scroll-area>
  </q-pull-to-refresh>
</template>

<script setup lang="ts">
import type { QScrollArea } from 'quasar';
import { onMounted, ref } from 'vue';

withDefaults(
  defineProps<{
    disable?: boolean;
  }>(),
  {
    disable: false,
  }
);

const emit = defineEmits<{
  (event: 'refresh', done: () => void): void;
}>();

const scrollAreaRef = ref<QScrollArea | null>(null);
const scrollTarget = ref<Element>();

onMounted(() => {
  scrollTarget.value = scrollAreaRef.value?.getScrollTarget();
});

function handleRefresh(done: () => void): void {
  emit('refresh', done);
}
</script>

<style scoped>
.pull-to-refresh-scroll-area,
.pull-to-refresh-scroll-area :deep(.q-pull-to-refresh__content),
.pull-to-refresh-scroll-area__scroll {
  height: 100%;
  min-height: 0;
}

.pull-to-refresh-scroll-area {
  overflow: hidden;
}
</style>
